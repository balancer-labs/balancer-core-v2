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

import "../lib/math/Math.sol";
import "../lib/helpers/ReentrancyGuard.sol";

import "./Fees.sol";

abstract contract InternalBalance is ReentrancyGuard, Fees {
    using Math for uint256;
    using SafeERC20 for IERC20;

    // user -> token -> internal balance
    mapping(address => mapping(IERC20 => uint256)) private _internalTokenBalance;

    event InternalBalanceDeposited(
        address indexed depositor,
        address indexed user,
        IERC20 indexed token,
        uint256 amount
    );

    event InternalBalanceWithdrawn(
        address indexed user,
        address indexed recipient,
        IERC20 indexed token,
        uint256 amount
    );

    event InternalBalanceTransferred(address indexed from, address indexed to, IERC20 indexed token, uint256 amount);

    function getInternalBalance(address user, IERC20[] memory tokens)
        external
        view
        override
        returns (uint256[] memory)
    {
        uint256[] memory balances = new uint256[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            balances[i] = _getInternalBalance(user, tokens[i]);
        }

        return balances;
    }

    function depositToInternalBalance(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        address user
    ) external override nonReentrant {
        require(tokens.length == amounts.length, "ERR_TOKENS_AMOUNTS_LEN_MISMATCH");

        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20 token = tokens[i];
            uint256 amount = amounts[i];

            _increaseInternalBalance(user, token, amount);
            token.safeTransferFrom(msg.sender, address(this), amount);
            emit InternalBalanceDeposited(msg.sender, user, token, amount);
        }
    }

    function withdrawFromInternalBalance(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        address recipient
    ) external override nonReentrant {
        require(tokens.length == amounts.length, "ERR_TOKENS_AMOUNTS_LEN_MISMATCH");

        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20 token = tokens[i];
            uint256 amount = amounts[i];

            uint256 feeAmount = _calculateProtocolWithdrawFeeAmount(amount);
            _increaseCollectedFees(token, feeAmount);

            _decreaseInternalBalance(msg.sender, token, amount);
            token.safeTransfer(recipient, amount.sub(feeAmount));
            emit InternalBalanceWithdrawn(msg.sender, recipient, token, amount);
        }
    }

    function transferInternalBalance(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        address recipient
    ) external override nonReentrant {
        require(tokens.length == amounts.length, "ERR_TOKENS_AMOUNTS_LEN_MISMATCH");

        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20 token = tokens[i];
            uint256 amount = amounts[i];

            _decreaseInternalBalance(msg.sender, token, amount);
            _increaseInternalBalance(recipient, token, amount);
            emit InternalBalanceTransferred(msg.sender, recipient, token, amount);
        }
    }

    function _increaseInternalBalance(
        address account,
        IERC20 token,
        uint256 amount
    ) internal {
        uint256 currentInternalBalance = _getInternalBalance(account, token);
        uint256 newBalance = currentInternalBalance.add(amount);
        _setInternalBalance(account, token, newBalance);
    }

    function _decreaseInternalBalance(
        address account,
        IERC20 token,
        uint256 amount
    ) internal {
        uint256 currentInternalBalance = _getInternalBalance(account, token);
        require(currentInternalBalance >= amount, "ERR_NOT_ENOUGH_INTERNAL_BALANCE");
        uint256 newBalance = currentInternalBalance - amount;
        _setInternalBalance(account, token, newBalance);
    }

    function _setInternalBalance(
        address account,
        IERC20 token,
        uint256 balance
    ) internal {
        _internalTokenBalance[account][token] = balance;
    }

    function _getInternalBalance(address account, IERC20 token) internal view returns (uint256) {
        return _internalTokenBalance[account][token];
    }
}
