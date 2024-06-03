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

pragma solidity >=0.7.0 <0.9.0;

import "@balancer-labs/v2-interfaces/contracts/standalone-utils/IProtocolFeeSplitter.sol";
import "@balancer-labs/v2-interfaces/contracts/standalone-utils/IProtocolFeesWithdrawer.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IVault.sol";

import "@balancer-labs/v2-solidity-utils/contracts/helpers/SingletonAuthentication.sol";
import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/EnumerableMap.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";

interface Pool {
    function getOwner() external view returns (address);
}

interface Factory {
    function isPoolFromFactory(address pool) external view returns (bool);
}

/**
 * @notice Support revenue sharing for individual pools between the DAO and designated recipients.
 * @dev This contract is responsible for splitting the BPT profits collected by the ProtocolFeeCollector between
 * a beneficiary specified by the pool's owner and the DAO fee recipient (e.g., the Balancer DAO treasury account).
 * Only BPT tokens are involved in the split: any other tokens would remain in the `ProtocolFeeCollector`.
 *
 * BPT tokens are withdrawn using the ProtocolFeesWithdrawer, a wrapper around the ProtocolFeesCollector that allows
 * governance to prevent certain tokens (on a denyList) from being withdrawn. `collectFees` would fail if the BPT
 * token were on this denyList.
 */
contract ProtocolFeeSplitter is IProtocolFeeSplitter, SingletonAuthentication {
    using EnumerableMap for EnumerableMap.IERC20ToUint256Map;
    using FixedPoint for uint256;

    string private constant _UNDEFINED_FACTORY_SHARE = "Share undefined for this factory";

    // All fee percentages are 18-decimal fixed point numbers.
    // Absolute maximum fee percentage (1e18 = 100%).
    uint256 private constant _MAX_REVENUE_SHARE_PERCENTAGE = 50e16; // 50%

    IProtocolFeesWithdrawer private immutable _protocolFeesWithdrawer;

    // The recipient of the DAO portion of the revenue share; e.g., the Balancer DAO treasury account.
    address private _daoFundsRecipient;

    // The default revenue share given to pools; can be updated by governance (1e18 = 100%, 1e16 = 1%).
    uint256 private _defaultRevenueSharePercentage;

    // Allow the default revenue sharing fee percentage to be overridden for individual factories.
    EnumerableMap.IERC20ToUint256Map private _revenueShareFactoryOverrides;

    // By default, the `overrideSet` flag is false, and all Pools use the default revenue share percentage.

    // Packed to use 1 storage slot
    // 1e18 (100% - maximum fee value) can fit in uint88
    struct RevenueShareSettings {
        uint88 revenueSharePercentageOverride;
        address beneficiary;
        bool overrideSet;
    }

    // poolId => PoolSettings
    mapping(bytes32 => RevenueShareSettings) private _poolSettings;

    constructor(IProtocolFeesWithdrawer protocolFeesWithdrawer, address daoFundsRecipient)
        SingletonAuthentication(protocolFeesWithdrawer.getProtocolFeesCollector().vault())
    {
        _protocolFeesWithdrawer = protocolFeesWithdrawer;
        _daoFundsRecipient = daoFundsRecipient;
    }

    // Fund recipients

    /// @inheritdoc IProtocolFeeSplitter
    function getDaoFundsRecipient() external view override returns (address) {
        return _daoFundsRecipient;
    }

    function setFactoryDefaultRevenueSharePercentage(address factory, uint256 feePercentage)
        external
        override
        authenticate
    {
        _require(feePercentage <= _MAX_REVENUE_SHARE_PERCENTAGE, Errors.SPLITTER_FEE_PERCENTAGE_TOO_HIGH);
        _revenueShareFactoryOverrides.set(IERC20(factory), feePercentage);

        emit FactoryDefaultRevenueSharePercentageChanged(factory, feePercentage);
    }

    function clearFactoryDefaultRevenueSharePercentage(address factory) external override authenticate {
        require(_revenueShareFactoryOverrides.remove(IERC20(factory)), _UNDEFINED_FACTORY_SHARE);

        emit FactoryDefaultRevenueSharePercentageCleared(factory);
    }

    /// @inheritdoc IProtocolFeeSplitter
    function setDaoFundsRecipient(address newDaoFundsRecipient) external override authenticate {
        _daoFundsRecipient = newDaoFundsRecipient;

        emit DAOFundsRecipientChanged(newDaoFundsRecipient);
    }

    /// @inheritdoc IProtocolFeeSplitter
    function setPoolBeneficiary(bytes32 poolId, address newBeneficiary) external override {
        (address pool, ) = getVault().getPool(poolId);
        _require(
            msg.sender == Pool(pool).getOwner() ||
                _canPerform(getActionId(this.setPoolBeneficiary.selector), msg.sender),
            Errors.SENDER_NOT_ALLOWED
        );

        _poolSettings[poolId].beneficiary = newBeneficiary;

        emit PoolBeneficiaryChanged(poolId, newBeneficiary);
    }

    // Revenue share settings

    /// @inheritdoc IProtocolFeeSplitter
    function getRevenueShareSettings(bytes32 poolId)
        external
        view
        override
        returns (
            uint256 revenueSharePercentageOverride,
            address beneficiary,
            bool overrideSet
        )
    {
        RevenueShareSettings memory settings = _poolSettings[poolId];

        return (settings.revenueSharePercentageOverride, settings.beneficiary, settings.overrideSet);
    }

    /// @inheritdoc IProtocolFeeSplitter
    function getDefaultRevenueSharePercentage() external view override returns (uint256) {
        return _defaultRevenueSharePercentage;
    }

    /// @inheritdoc IProtocolFeeSplitter
    function setDefaultRevenueSharePercentage(uint256 defaultRevenueSharePercentage) external override authenticate {
        _require(
            defaultRevenueSharePercentage <= _MAX_REVENUE_SHARE_PERCENTAGE,
            Errors.SPLITTER_FEE_PERCENTAGE_TOO_HIGH
        );
        _defaultRevenueSharePercentage = defaultRevenueSharePercentage;

        emit DefaultRevenueSharePercentageChanged(defaultRevenueSharePercentage);
    }

    /// @inheritdoc IProtocolFeeSplitter
    function setRevenueSharePercentage(bytes32 poolId, uint256 revenueSharePercentage) external override authenticate {
        _require(revenueSharePercentage <= _MAX_REVENUE_SHARE_PERCENTAGE, Errors.SPLITTER_FEE_PERCENTAGE_TOO_HIGH);
        _poolSettings[poolId].revenueSharePercentageOverride = uint88(revenueSharePercentage);
        _poolSettings[poolId].overrideSet = true;

        emit PoolRevenueShareChanged(poolId, revenueSharePercentage);
    }

    /**
     * @notice Ignore any previously set revenue sharing percentage, and begin using the default.
     * @param poolId - the poolId of the pool to begin using the default revenue share percentage.
     */
    function clearRevenueSharePercentage(bytes32 poolId) external override authenticate {
        _poolSettings[poolId].overrideSet = false;

        emit PoolRevenueShareCleared(poolId);
    }

    // Permissionless fee collection functions

    /// @inheritdoc IProtocolFeeSplitter
    function getAmounts(bytes32 poolId) external view override returns (uint256 beneficiaryAmount, uint256 daoAmount) {
        (address pool, ) = getVault().getPool(poolId);
        IERC20 bpt = IERC20(pool);

        return _getAmounts(bpt, poolId);
    }

    /// @inheritdoc IProtocolFeeSplitter
    function collectFees(bytes32 poolId) external override returns (uint256 beneficiaryAmount, uint256 daoAmount) {
        (address pool, ) = getVault().getPool(poolId);
        IERC20 bpt = IERC20(pool);
        address beneficiary = _poolSettings[poolId].beneficiary;

        (beneficiaryAmount, daoAmount) = _getAmounts(bpt, poolId);

        _withdrawBpt(bpt, beneficiaryAmount, beneficiary);
        _withdrawBpt(bpt, daoAmount, _daoFundsRecipient);

        emit FeesCollected(poolId, beneficiary, beneficiaryAmount, _daoFundsRecipient, daoAmount);
    }

    // Misc getters

    /// @inheritdoc IProtocolFeeSplitter
    function getProtocolFeesWithdrawer() external view override returns (IProtocolFeesWithdrawer) {
        return _protocolFeesWithdrawer;
    }

    // Internal functions

    function getFactoryDefaultRevenueSharePercentage(address factory) external view override returns (uint256) {
        require(_revenueShareFactoryOverrides.contains(IERC20(factory)), _UNDEFINED_FACTORY_SHARE);

        // We have checked about that the key exists, so `get` should not revert.
        return _revenueShareFactoryOverrides.get(IERC20(factory), Errors.SHOULD_NOT_HAPPEN);
    }

    function _withdrawBpt(
        IERC20 bpt,
        uint256 amount,
        address to
    ) private {
        if (amount == 0) {
            return;
        }

        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = bpt;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        _protocolFeesWithdrawer.withdrawCollectedFees(tokens, amounts, to);
    }

    function _getAmounts(IERC20 bpt, bytes32 poolId) private view returns (uint256, uint256) {
        IProtocolFeesWithdrawer protocolFeesWithdrawer = _protocolFeesWithdrawer;
        uint256 feeCollectorBptBalance = bpt.balanceOf(address(protocolFeesWithdrawer.getProtocolFeesCollector()));
        if (feeCollectorBptBalance == 0) {
            return (0, 0);
        }

        address beneficiary = _poolSettings[poolId].beneficiary;

        if (beneficiary == address(0)) {
            // If there's no beneficiary, the full amount is sent to the DAO recipient.
            return (0, feeCollectorBptBalance);
        } else {
            // Otherwise, split the fee between the beneficiary and the DAO recipient,
            // according to the share percentage.
            return _computeAmounts(feeCollectorBptBalance, _getPoolBeneficiaryFeePercentage(poolId));
        }
    }

    function _computeAmounts(uint256 feeCollectorBptBalance, uint256 feePercentage)
        private
        pure
        returns (uint256 ownerAmount, uint256 daoAmount)
    {
        ownerAmount = feeCollectorBptBalance.mulDown(feePercentage);
        daoAmount = feeCollectorBptBalance.sub(ownerAmount);
    }

    function _getPoolBeneficiaryFeePercentage(bytes32 poolId) private view returns (uint256) {
        RevenueShareSettings memory settings = _poolSettings[poolId];

        if (settings.overrideSet) {
            // If there is an override for this specific pool, use it.
            return settings.revenueSharePercentageOverride;
        }

        // Is this pool from a factory with an overridden default? If so, use it.
        (address poolAddress, ) = getVault().getPool(poolId);

        for (uint256 i = 0; i < _revenueShareFactoryOverrides.length(); i++) {
            (IERC20 factoryAddress, uint256 factoryDefaultRevenueSharePercentage) = _revenueShareFactoryOverrides
                .unchecked_at(i);

            if (Factory(address(factoryAddress)).isPoolFromFactory(poolAddress)) {
                return factoryDefaultRevenueSharePercentage;
            }
        }

        // If there is no override set, and no factory override, fall back to the overall default.
        return _defaultRevenueSharePercentage;
    }
}
