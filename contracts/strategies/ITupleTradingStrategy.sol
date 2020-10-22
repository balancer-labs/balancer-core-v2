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

interface ITupleTradingStrategy {
    function validateTuple(
        bytes32 poolId,
        address tokenAddressIn,
        address tokenAddressOut,
        uint8 tokenIndexIn,
        uint8 tokenIndexOut,
        uint256[] calldata balances,
        uint256 tokenAmountIn,
        uint256 tokenAmountOut
    ) external returns (bool, uint256);
}
