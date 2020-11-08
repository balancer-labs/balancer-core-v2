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

pragma solidity ^0.7.1;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/utils/SafeCast.sol";

import "../math/FixedPoint.sol";

import "./IVault.sol";
import "./Settings.sol";

library BalanceLib {
    using FixedPoint for uint128;

    // This data structure is used to represent a token's balance for a Pool. 'cash' is how many tokens the Pool has
    // sitting inside of the Vault. 'total' is always larger or equal to 'cash', and represents the Pool's total token
    // balance, including tokens that are *not* inside of the Vault.
    //
    // Cash and total are updated in concordance whenever tokens are added/removed from a Pool, except when interacting
    // with the Pool's Investment Manager. The Investment Manager updates the new 'total' value (according to its own)
    // internal logic, which the Vault uses when validating swaps with the Pool's Trading Strategy, as well as returns
    // profits by returning invested 'cash'.
    //
    // The Vault disallows the Pool's 'cash' ever becoming negative, in other words, it can never use any tokens that
    // are not inside of the Vault.
    struct Balance {
        uint128 cash;
        uint128 total;
    }

    /**
     * @dev The number of invested assets. This is simply the difference between 'total' and 'cash' - the Vault has no
     * insights into how the assets are used by the Investment Manager.
     */
    function invested(Balance memory self) internal view returns (uint128) {
        return self.total - self.cash;
    }

    /**
     * @dev Increases a Pool's balance. Called when tokens are added to the Pool (except from the Investment Manager).
     */
    function increase(Balance memory self, uint128 amount)
        internal
        pure
        returns (Balance memory)
    {
        return
            Balance({
                cash: self.cash.add128(amount),
                total: self.total.add128(amount)
            });
    }

    /**
     * @dev Decreases a Pool's balance. Called when tokens are removed from the Pool (except to the Investment Manager).
     */
    function decrease(Balance memory self, uint128 amount)
        internal
        pure
        returns (Balance memory)
    {
        return
            Balance({
                cash: self.cash.sub128(amount),
                total: self.total.sub128(amount)
            });
    }
}

abstract contract VaultAccounting is IVault, Settings {
    using BalanceLib for BalanceLib.Balance;
    using FixedPoint for uint256;
    using FixedPoint for uint128;
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    // The Vault's accounted-for balance for each token. This should always be equal to the sum of all User Balance
    // tokens, plus all 'cash' of all Pools.
    // TODO: make this uint128 and not Balance, since it consists exclusively of 'cash'.
    mapping(address => BalanceLib.Balance) internal _vaultTokenBalance; // token -> vault balance

    function getTotalUnaccountedForTokens(address token)
        public
        view
        override
        returns (uint256)
    {
        uint256 totalBalance = IERC20(token).balanceOf(address(this));
        assert(totalBalance >= _vaultTokenBalance[token].cash);

        return totalBalance - _vaultTokenBalance[token].cash;
    }

    /**
     * @dev Transfers tokens into the Vault from `from`. The caller must verify that this action was authorized by
     * `from` (typically by the entry-point function being called by an operator for `from`).
     *
     * The number of tokens received are measured as a delta, by calling `IERC20.balanceOf` before and after the
     * transfer. This means tokens with a transfer fee are supported. The number of tokens received is returned.
     */
    function _pullTokens(
        address token,
        address from,
        uint128 amount
    ) internal returns (uint128) {
        if (amount == 0) {
            return 0;
        }

        uint256 currentBalance = IERC20(token).balanceOf(address(this));

        IERC20(token).safeTransferFrom(from, address(this), amount);

        uint256 newBalance = IERC20(token).balanceOf(address(this));

        uint128 received = newBalance.sub(currentBalance).toUint128();

        _vaultTokenBalance[token] = _vaultTokenBalance[token].increase(
            received
        );

        return received;
    }

    /**
     * @dev Transfers tokens from the Vault to `to`. If `chargeFee` is true, a withdrawal fee will be charged as
     * unaccounted-for tokens.
     */
    function _pushTokens(
        address token,
        address to,
        uint128 amount,
        bool chargeFee
    ) internal {
        if (amount == 0) {
            return;
        }

        _vaultTokenBalance[token] = _vaultTokenBalance[token].decrease(amount);

        uint128 amountToSend = chargeFee
            ? _applyProtocolWithdrawFee(amount)
            : amount;

        IERC20(token).safeTransfer(to, amountToSend);
    }
}
