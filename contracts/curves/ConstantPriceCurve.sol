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

pragma solidity 0.7.1;

import "./ICurve.sol";
import "../math/FixedPoint.sol";
import "../LogExpMath.sol";

// Trivial curve for testing purposes only
contract ConstantPriceCurve is ICurve, FixedPoint {
    function spotPrice(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) external override pure returns (uint256) {
        return 1;
    }

    function calculateOutGivenIn(
        uint256,
        uint256,
        uint256 tokenBalanceIn,
        uint256,
        uint256
    ) public override pure returns (uint256) {
        return tokenBalanceIn;
    }

    function calculateInvariant(uint256[] memory)
        public
        override
        pure
        returns (uint256)
    {
        return 1;
    }

    function validateOutGivenIn(
        uint256,
        uint256,
        uint256,
        uint256,
        uint256 tokenAmountIn,
        uint256 tokenAmountOut
    ) external override pure returns (bool) {
        return tokenAmountOut >= tokenAmountIn;
    }

    function validateBalances(
        uint256[] calldata oldBalances,
        uint256[] calldata newBalances
    ) external override pure returns (bool) {
        //Calculate old invariant
        uint256 oldInvariant = calculateInvariant(oldBalances);

        //Calculate new invariant
        uint256 newInvariant = calculateInvariant(newBalances);

        return newInvariant >= oldInvariant;
    }
}
