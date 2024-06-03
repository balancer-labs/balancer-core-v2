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

import "../vault/IVault.sol";
import "./IProtocolFeesWithdrawer.sol";

/**
 * @title ProtocolFeeSplitter
 * @author Daoism Systems
 * @notice Distributes protocol fees collected from a particular pool between a DAO fund recipient
 * (e.g., the Balancer DAO treasury), and a beneficiary designated by the pool owner.
 * @dev By default, all funds go to the DAO. To claim a share of the protocol fees, pool owners
 * may call `setPoolBeneficiary`.
 */
interface IProtocolFeeSplitter {
    event FeesCollected(
        bytes32 indexed poolId,
        address indexed beneficiary,
        uint256 poolEarned,
        address indexed daoFundsRecipient,
        uint256 daoEarned
    );

    event PoolRevenueShareChanged(bytes32 indexed poolId, uint256 revenueSharePercentage);
    event PoolRevenueShareCleared(bytes32 indexed poolId);
    event PoolBeneficiaryChanged(bytes32 indexed poolId, address newBeneficiary);
    event DefaultRevenueSharePercentageChanged(uint256 revenueSharePercentage);
    event FactoryDefaultRevenueSharePercentageChanged(address indexed factory, uint256 revenueSharePercentage);
    event FactoryDefaultRevenueSharePercentageCleared(address indexed factory);
    event DAOFundsRecipientChanged(address newDaoFundsRecipient);

    // Fund recipients

    /**
     * @notice Returns the DAO funds recipient that will receive any balance not due to the pool beneficiary.
     */
    function getDaoFundsRecipient() external view returns (address);

    /**
     * @notice Allows a authorized user to change the DAO funds recipient.
     * @dev This is a permissioned function.
     * @param newDaoFundsRecipient - address of the new DAO funds recipient.
     */
    function setDaoFundsRecipient(address newDaoFundsRecipient) external;

    /**
     * @notice Allows a pool owner to change the revenue share beneficiary for a given pool.
     * @dev This is a permissioned function.
     * @param poolId - the poolId of the pool where the beneficiary will change.
     * @param newBeneficiary - address of the new beneficiary.
     */
    function setPoolBeneficiary(bytes32 poolId, address newBeneficiary) external;

    // Revenue share settings

    /**
     * @dev Returns the current protocol fee split configuration for a given pool.
     * @param poolId - the poolId of a pool with accrued protocol fees.
     * @return revenueSharePercentageOverride - the percentage of the split sent to the pool beneficiary.
     * @return beneficiary - the address of the pool beneficiary.
     */
    function getRevenueShareSettings(bytes32 poolId)
        external
        view
        returns (
            uint256 revenueSharePercentageOverride,
            address beneficiary,
            bool overrideSet
        );

    /**
     * @dev Returns the default revenue share percentage a pool will receive, unless overridden by a call
     * to `setRevenueSharePercentage`.
     */
    function getDefaultRevenueSharePercentage() external view returns (uint256);

    /**
     * @notice Allows an authorized user to change the default revenue share percentage.
     * @dev Set the default revenue share percentage, applied to pools where no override has been set
     * through `setRevenueSharePercentage`. Must be below the maximum allowed split.
     * This is a permissioned function.
     * @param defaultRevenueSharePercentage - new default revenue share percentage
     */
    function setDefaultRevenueSharePercentage(uint256 defaultRevenueSharePercentage) external;

    /**
     * @notice Returns the revenue share associated with the given factory
     * @dev Reverts if no revenue share was set for this factory
     * @param factory - the address of the factory with a default revenue share percentage
     */
    function getFactoryDefaultRevenueSharePercentage(address factory) external view returns (uint256);

    /**
     * @notice Allows a authorized user to change the default revenue sharing fee percentage for a given factory
     * @param factory - address of the factory
     * @param feePercentage - new default revenue sharing fee percentage
     */
    function setFactoryDefaultRevenueSharePercentage(address factory, uint256 feePercentage) external;

    /**
     * @notice Allows a authorized user to remove a default revenue sharing fee override for a given factory
     * @param factory - address of the factory
     */
    function clearFactoryDefaultRevenueSharePercentage(address factory) external;

    /**
     * @notice Ignore any previously set revenue sharing percentage, and begin using the default.
     * @param poolId - the poolId of the pool to begin using the default revenue share percentage.
     */
    function setRevenueSharePercentage(bytes32 poolId, uint256 revenueSharePercentage) external;

    /**
     * @notice Allows an authorized user to change the revenueShare for a given pool.
     * @dev This is a permissioned function.
     * @param poolId - the poolId of the pool where the revenue share will change.
     */
    function clearRevenueSharePercentage(bytes32 poolId) external;

    // Permissionless fee collection functions

    /**
     * @dev Returns the amount of fees that would be sent to each beneficiary in a call to `collectFees`.
     * @param poolId - the poolId of a pool with accrued protocol fees.
     * @return beneficiaryAmount - the BPT amount that would be sent to the pool beneficiary.
     * @return daoAmount - the BPT amount that would be sent to the DAO funds recipient.
     */
    function getAmounts(bytes32 poolId) external view returns (uint256 beneficiaryAmount, uint256 daoAmount);

    /**
     * @dev Permissionless function to collect and distribute any accrued protocol fees for the given pool.
     * @param poolId - the poolId of a pool with accrued protocol fees.
     * @return beneficiaryAmount - the BPT amount sent to the pool beneficiary.
     * @return daoAmount - the BPT amount sent to the DAO funds recipient.
     */
    function collectFees(bytes32 poolId) external returns (uint256 beneficiaryAmount, uint256 daoAmount);

    // Misc getters

    /**
     * @notice Returns the `ProtocolFeesWithdrawer`, used to withdraw funds from the `ProtocolFeesCollector`.
     */
    function getProtocolFeesWithdrawer() external view returns (IProtocolFeesWithdrawer);
}
