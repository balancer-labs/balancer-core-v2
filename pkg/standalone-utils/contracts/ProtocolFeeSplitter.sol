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
import "@balancer-labs/v2-solidity-utils/contracts/helpers/Authentication.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";
import "@balancer-labs/v2-interfaces/contracts/vault/IProtocolFeesCollector.sol";

interface Pool {
    function getOwner() external view returns (address);
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
contract ProtocolFeeSplitter is IProtocolFeeSplitter, Authentication {
    using FixedPoint for uint256;

    // All fee percentages are 18-decimal fixed point numbers.
    // Absolute maximum fee percentage (1e18 = 100%).
    uint256 private constant _MAX_REVENUE_SHARE_PERCENTAGE = 50e16; // 50%

    IProtocolFeesWithdrawer private immutable _protocolFeesWithdrawer;

    // Balancer vault
    IVault private immutable _vault;

    // The recipient of the DAO portion of the revenue share; e.g., the Balancer DAO treasury account.
    address private _daoFundsRecipient;

    // The default revenue share given to pools; can be updated by governance (1e18 = 100%, 1e16 = 1%).
    uint256 private _defaultRevenueSharePercentage;

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
        // The ProtocolFeeSplitter is a singleton, so it simply uses its own address to disambiguate action
        // identifiers.
        Authentication(bytes32(uint256(address(this))))
    {
        _protocolFeesWithdrawer = protocolFeesWithdrawer;
        _daoFundsRecipient = daoFundsRecipient;
        _vault = protocolFeesWithdrawer.getProtocolFeesCollector().vault();
    }

    function setRevenueSharePercentage(bytes32 poolId, uint256 newRevenueSharePercentage)
        external
        override
        authenticate
    {
        _require(newRevenueSharePercentage <= _MAX_REVENUE_SHARE_PERCENTAGE, Errors.SPLITTER_FEE_PERCENTAGE_TOO_HIGH);
        _poolSettings[poolId].revenueSharePercentageOverride = uint88(newRevenueSharePercentage);
        _poolSettings[poolId].overrideSet = true;

        emit PoolRevenueShareChanged(poolId, newRevenueSharePercentage);
    }

    function clearRevenueSharePercentage(bytes32 poolId) external override authenticate {
        _poolSettings[poolId].overrideSet = false;

        emit PoolRevenueShareCleared(poolId);
    }

    function setDefaultRevenueSharePercentage(uint256 feePercentage) external override authenticate {
        _require(feePercentage <= _MAX_REVENUE_SHARE_PERCENTAGE, Errors.SPLITTER_FEE_PERCENTAGE_TOO_HIGH);
        _defaultRevenueSharePercentage = feePercentage;
        emit DefaultRevenueSharePercentageChanged(feePercentage);
    }

    /// @inheritdoc IProtocolFeeSplitter
    function setDaoFundsRecipient(address newDaoFundsRecipient) external override authenticate {
        _daoFundsRecipient = newDaoFundsRecipient;

        emit DAOFundsRecipientChanged(newDaoFundsRecipient);
    }

    /// @inheritdoc IProtocolFeeSplitter
    function setPoolBeneficiary(bytes32 poolId, address newBeneficiary) external override {
        (address pool, ) = _vault.getPool(poolId);
        _require(msg.sender == Pool(pool).getOwner(), Errors.SENDER_NOT_ALLOWED);

        _poolSettings[poolId].beneficiary = newBeneficiary;

        emit PoolBeneficiaryChanged(poolId, newBeneficiary);
    }

    /// @inheritdoc IProtocolFeeSplitter
    function collectFees(bytes32 poolId) external override returns (uint256 beneficiaryAmount, uint256 daoAmount) {
        (address pool, ) = _vault.getPool(poolId);
        IERC20 bpt = IERC20(pool);
        address beneficiary = _poolSettings[poolId].beneficiary;

        (beneficiaryAmount, daoAmount) = _getAmounts(bpt, poolId);

        _withdrawBpt(bpt, beneficiaryAmount, beneficiary);
        _withdrawBpt(bpt, daoAmount, _daoFundsRecipient);

        emit FeesCollected(poolId, beneficiary, beneficiaryAmount, _daoFundsRecipient, daoAmount);
    }

    /// @inheritdoc IProtocolFeeSplitter
    function getAmounts(bytes32 poolId) external view override returns (uint256 beneficiaryAmount, uint256 daoAmount) {
        (address pool, ) = _vault.getPool(poolId);
        IERC20 bpt = IERC20(pool);

        return _getAmounts(bpt, poolId);
    }

    /// @inheritdoc IProtocolFeeSplitter
    function getProtocolFeesWithdrawer() external view override returns (IProtocolFeesWithdrawer) {
        return _protocolFeesWithdrawer;
    }

    /// @inheritdoc IProtocolFeeSplitter
    function getDefaultRevenueSharePercentage() external view override returns (uint256) {
        return _defaultRevenueSharePercentage;
    }

    /// @inheritdoc IProtocolFeeSplitter
    function getVault() external view override returns (IVault) {
        return _vault;
    }

    /// @inheritdoc IProtocolFeeSplitter
    function getDaoFundsRecipient() external view override returns (address) {
        return _daoFundsRecipient;
    }

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

    function _canPerform(bytes32 actionId, address account) internal view override returns (bool) {
        return _getAuthorizer().canPerform(actionId, account, address(this));
    }

    function _getAuthorizer() internal view returns (IAuthorizer) {
        return _protocolFeesWithdrawer.getProtocolFeesCollector().getAuthorizer();
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

        return settings.overrideSet ? settings.revenueSharePercentageOverride : _defaultRevenueSharePercentage;
    }
}
