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

import "../vault/balances/BalanceAllocation112.sol";

contract BalanceAllocation112Mock {
    using BalanceAllocation112 for bytes32;

    function total(bytes32 balance) public pure returns (uint256) {
        return balance.total();
    }

    function totals(bytes32[] memory balances) public pure returns (uint256[] memory) {
        return BalanceAllocation112.totals(balances);
    }

    function cash(bytes32 balance) public pure returns (uint256) {
        return balance.cash();
    }

    function managed(bytes32 balance) public pure returns (uint256) {
        return balance.managed();
    }

    function blockNumber(bytes32 balance) public pure returns (uint256) {
        return balance.blockNumber();
    }

    function toBalance(uint256 _cash, uint256 _managed, uint256 _blockNumber) public pure returns (bytes32) {
        return BalanceAllocation112.toBalance(_cash, _managed, _blockNumber);
    }

    function increaseCash(bytes32 balance, uint256 amount) public pure returns (bytes32) {
        return balance.increaseCash(amount);
    }

    function decreaseCash(bytes32 balance, uint256 amount) public pure returns (bytes32) {
        return balance.decreaseCash(amount);
    }

    function cashToManaged(bytes32 balance, uint256 amount) public pure returns (bytes32) {
        return balance.cashToManaged(amount);
    }

    function managedToCash(bytes32 balance, uint256 amount) public pure returns (bytes32) {
        return balance.managedToCash(amount);
    }

    function setManagedBalance(bytes32 balance, uint256 newManaged) public pure returns (bytes32) {
        return balance.setManaged(newManaged);
    }

    function fromSharedToBalanceA(bytes32 sharedCash, bytes32 sharedManaged) public pure returns (bytes32) {
        return BalanceAllocation112.fromSharedToBalanceA(sharedCash, sharedManaged);
    }

    function fromSharedToBalanceB(bytes32 sharedCash, bytes32 sharedManaged) public pure returns (bytes32) {
        return BalanceAllocation112.fromSharedToBalanceB(sharedCash, sharedManaged);
    }

    function toSharedCash(bytes32 tokenABalance, bytes32 tokenBBalance) public pure returns (bytes32) {
        return BalanceAllocation112.toSharedCash(tokenABalance, tokenBBalance);
    }

    function toSharedManaged(bytes32 tokenABalance, bytes32 tokenBBalance) public pure returns (bytes32) {
        return BalanceAllocation112.toSharedManaged(tokenABalance, tokenBBalance);
    }
}
