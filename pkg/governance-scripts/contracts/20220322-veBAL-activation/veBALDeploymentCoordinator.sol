// SPDX-License-Identifier: GPL-3.0-or-later
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

pragma solidity ^0.7.0;

import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/ReentrancyGuard.sol";
import "@balancer-labs/v2-vault/contracts/interfaces/IVault.sol";

import "@balancer-labs/v2-liquidity-mining/contracts/interfaces/IAuthorizerAdaptor.sol";
import "@balancer-labs/v2-liquidity-mining/contracts/interfaces/IGaugeAdder.sol";
import "@balancer-labs/v2-liquidity-mining/contracts/interfaces/IGaugeController.sol";
import "@balancer-labs/v2-liquidity-mining/contracts/interfaces/IBalancerMinter.sol";
import "@balancer-labs/v2-liquidity-mining/contracts/interfaces/IBalancerTokenAdmin.sol";

// solhint-disable not-rely-on-time

/**
 * @dev The currently deployed Authorizer has a different interface relative to the Authorizer in the monorepo
 * for granting/revoking roles(referred to as permissions in the new Authorizer) and so we require a one-off interface
 */
interface ICurrentAuthorizer is IAuthorizer {
    // solhint-disable-next-line func-name-mixedcase
    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);

    function grantRole(bytes32 role, address account) external;

    function revokeRole(bytes32 role, address account) external;
}

// https://vote.balancer.fi/#/proposal/0x9fe19c491cf90ed2e3ed9c15761c43d39fd1fb732a940aba8058ff69787ee90a
// solhint-disable-next-line contract-name-camelcase
contract veBALDeploymentCoordinator is ReentrancyGuard {
    IBalancerTokenAdmin private immutable _balancerTokenAdmin;

    IVault private immutable _vault;
    IAuthorizerAdaptor private immutable _authorizerAdaptor;
    IBalancerToken private immutable _balancerToken;
    IBalancerMinter private immutable _balancerMinter;
    IGaugeController private immutable _gaugeController;

    enum DeploymentStage { PENDING, FIRST_STAGE_DONE, SECOND_STAGE_DONE }

    uint256 public firstStageActivationTime;
    uint256 public secondStageActivationTime;

    DeploymentStage private _currentDeploymentStage;
    uint256 private immutable _activationScheduledTime;
    uint256 private immutable _secondStageDelay;

    uint256 public constant LM_COMMITTEE_WEIGHT = 10e16; // 10%
    uint256 public constant VEBAL_WEIGHT = 10e16; // 10%
    uint256 public constant ETHEREUM_WEIGHT = 56e16; // 56%
    uint256 public constant POLYGON_WEIGHT = 17e16; // 17%
    uint256 public constant ARBITRUM_WEIGHT = 7e16; // 7%

    constructor(
        IBalancerMinter balancerMinter,
        IAuthorizerAdaptor authorizerAdaptor,
        uint256 activationScheduledTime,
        uint256 secondStageDelay
    ) {
        _currentDeploymentStage = DeploymentStage.PENDING;

        IBalancerTokenAdmin balancerTokenAdmin = balancerMinter.getBalancerTokenAdmin();

        _balancerTokenAdmin = balancerTokenAdmin;
        _vault = balancerTokenAdmin.getVault();
        _authorizerAdaptor = authorizerAdaptor;
        _balancerToken = balancerTokenAdmin.getBalancerToken();
        _balancerMinter = balancerMinter;
        _gaugeController = IGaugeController(balancerMinter.getGaugeController());

        _activationScheduledTime = activationScheduledTime;
        _secondStageDelay = secondStageDelay;
    }

    /**
     * @notice Returns the Balancer Vault.
     */
    function getVault() public view returns (IVault) {
        return _vault;
    }

    /**
     * @notice Returns the Balancer Vault's current authorizer.
     */
    function getAuthorizer() public view returns (IAuthorizer) {
        return getVault().getAuthorizer();
    }

    function getAuthorizerAdaptor() public view returns (IAuthorizerAdaptor) {
        return _authorizerAdaptor;
    }

    function getBalancerTokenAdmin() external view returns (IBalancerTokenAdmin) {
        return _balancerTokenAdmin;
    }

    function getBalancerMinter() external view returns (IBalancerMinter) {
        return _balancerMinter;
    }

    /**
     * @notice Returns the address of the Gauge Controller
     */
    function getGaugeController() external view returns (IGaugeController) {
        return _gaugeController;
    }

    function getCurrentDeploymentStage() external view returns (DeploymentStage) {
        return _currentDeploymentStage;
    }

    function getActivationScheduledTime() external view returns (uint256) {
        return _activationScheduledTime;
    }

    function getSecondStageDelay() external view returns (uint256) {
        return _secondStageDelay;
    }

    function performFirstStage() external nonReentrant {
        // Check internal state
        require(block.timestamp >= _activationScheduledTime, "Not ready for activation");
        require(_currentDeploymentStage == DeploymentStage.PENDING, "First step already performed");

        // Check external state: we need admin permission on both the BAL token and the Authorizer
        ICurrentAuthorizer authorizer = ICurrentAuthorizer(address(getAuthorizer()));
        require(_balancerToken.hasRole(_balancerToken.DEFAULT_ADMIN_ROLE(), address(this)), "Not BAL admin");
        require(authorizer.canPerform(bytes32(0), address(this), address(0)), "Not Authorizer admin");

        // Also require that Balancer governance holds all relevant admin rights
        IAuthorizerAdaptor authorizerAdaptor = getAuthorizerAdaptor();
        require(
            _gaugeController.voting_escrow().admin() == authorizerAdaptor,
            "VotingEscrow not owned by AuthorizerAdaptor"
        );
        require(_gaugeController.admin() == authorizerAdaptor, "GaugeController not owned by AuthorizerAdaptor");

        // Sanity checks
        require(_gaugeController.n_gauge_types() == 0, "Gauge types already set");

        // Step 1: trigger BAL token admin migration, locking the BAL emissions forever.
        //
        // The BalancerTokenAdmin contracts needs admin permission over BAL in order to complete this process, and we
        // need to be authorized to make the call.
        _balancerToken.grantRole(_balancerToken.DEFAULT_ADMIN_ROLE(), address(_balancerTokenAdmin));
        authorizer.grantRole(_balancerTokenAdmin.getActionId(IBalancerTokenAdmin.activate.selector), address(this));
        _balancerTokenAdmin.activate();
        // Balancer Token Admin activation automatically removes authority over the BAL token from all other accounts,
        // so we don't need to renounce this permission.

        // Step 2: grant BalancerMinter authority to mint BAL, as part of the Liquidity Mining program.
        authorizer.grantRole(
            _balancerTokenAdmin.getActionId(IBalancerTokenAdmin.mint.selector),
            address(_balancerMinter)
        );

        // Step 3: setup the Liquidity Mining program by creating the different gauge types on the Gauge Controller.
        //
        // All gauge types are initially created with a weight of 0, which will allow for gauges to be deployed and LPs
        // to vote and stake for them, without yet minting any BAL. This is intended to provide a grace period for LPs
        // to migrate to the new system before it is fully activated. The gauge type weights will be set to their actual
        // values on the last stage of deployment.
        {
            // Note that the current Authorizer ignores the 'where' parameter, so we don't need to (cannot) indicate
            // that this permission should only be granted on the gauge controller itself.
            authorizer.grantRole(authorizerAdaptor.getActionId(IGaugeController.add_type.selector), address(this));

            _addGaugeType("Liquidity Mining Committee");
            _addGaugeType("veBAL");
            _addGaugeType("Ethereum");
            _addGaugeType("Polygon");
            _addGaugeType("Arbitrum");

            authorizer.revokeRole(authorizerAdaptor.getActionId(IGaugeController.add_type.selector), address(this));
        }

        // Step 4: create gauges for the single-gauge gauge types
        //
        // The LM committee and veBAL gauge types will have a single gauge of the single-recipient gauge kind

        // grant self power to add gauges
        // deploy lm, vebal, merkle gauges. add gauges to gauge controller

        // grant gauge adder authority over controller
        // grant self power over guage adder
        // add l1 and l2 factories to gauge adder
        // deploy l1 and l2 gauges, add to controller via gauge adder

        // add tokens to l1 and l2 gauges
        // grant batch relayer permissions

        firstStageActivationTime = block.timestamp;
        _currentDeploymentStage = DeploymentStage.FIRST_STAGE_DONE;
    }

    function performSecondStage() external nonReentrant {
        // Check delay from first stage
        require(_currentDeploymentStage == DeploymentStage.FIRST_STAGE_DONE, "First steap already performed");
        require(block.timestamp >= (firstStageActivationTime + _secondStageDelay), "Not ready for activation");

        // We can now set the actual weights for each gauge type, causing gauges to have non-zero weights once veBAL
        // holders vote for them.
        // Admin functions on the Gauge Controller have to be called via the the AuthorizerAdaptor, which acts as its
        // admin.
        IAuthorizerAdaptor authorizerAdaptor = getAuthorizerAdaptor();
        // Note that the current Authorizer ignores the 'where' parameter, so we don't need to (cannot) indicate
        // that this permission should only be granted on the gauge controller itself.
        ICurrentAuthorizer authorizer = ICurrentAuthorizer(address(getAuthorizer()));
        authorizer.grantRole(
            authorizerAdaptor.getActionId(IGaugeController.change_type_weight.selector),
            address(this)
        );

        _setGaugeTypeWeight(IGaugeAdder.GaugeType.LiquidityMiningCommittee, LM_COMMITTEE_WEIGHT);
        _setGaugeTypeWeight(IGaugeAdder.GaugeType.veBAL, VEBAL_WEIGHT);
        _setGaugeTypeWeight(IGaugeAdder.GaugeType.Ethereum, ETHEREUM_WEIGHT);
        _setGaugeTypeWeight(IGaugeAdder.GaugeType.Polygon, POLYGON_WEIGHT);
        _setGaugeTypeWeight(IGaugeAdder.GaugeType.Arbitrum, ARBITRUM_WEIGHT);

        authorizer.revokeRole(
            authorizerAdaptor.getActionId(IGaugeController.change_type_weight.selector),
            address(this)
        );

        // The entire system is now fully setup, and we can renounce permissions over the Authorizer
        authorizer.revokeRole(authorizer.DEFAULT_ADMIN_ROLE(), address(this));

        secondStageActivationTime = block.timestamp;
        _currentDeploymentStage = DeploymentStage.SECOND_STAGE_DONE;
    }

    function _addGaugeType(string memory name) private {
        getAuthorizerAdaptor().performAction(
            address(_gaugeController),
            abi.encodeWithSelector(IGaugeController.add_type.selector, name, 0)
        );
    }

    function _setGaugeTypeWeight(IGaugeAdder.GaugeType typeId, uint256 weight) private {
        getAuthorizerAdaptor().performAction(
            address(_gaugeController),
            abi.encodeWithSelector(IGaugeController.change_type_weight.selector, int128(typeId), weight)
        );
    }
}
