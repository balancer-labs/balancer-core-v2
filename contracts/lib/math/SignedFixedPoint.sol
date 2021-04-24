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

import "./LogExpMath.sol";
import "../helpers/BalancerErrors.sol";

/* solhint-disable private-vars-leading-underscore */

library SignedFixedPoint {
    int256 internal constant ONE = 1e18; // 18 decimal places

    int256 private constant _INT256_MIN = -2**255;

    /**
     * @dev Returns the fixed point addition of two signed integers, reverting on overflow.
     * It assumes both `a` and `b` are fixed point numbers.
     *
     * Requirements:
     *
     * - Addition cannot overflow.
     */
    function add(int256 a, int256 b) internal pure returns (int256) {
        int256 c = a + b;
        _require((b >= 0 && c >= a) || (b < 0 && c < a), Errors.ADD_OVERFLOW);

        return c;
    }

    /**
     * @dev Returns the fixed point multiplication of two signed integers, reverting on overflow.
     * It assumes both `a` and `b` are fixed point numbers.
     *
     * Requirements:
     *
     * - Multiplication cannot overflow.
     */
    function mul(int256 a, int256 b) internal pure returns (int256) {
        // Gas optimization: this is cheaper than requiring 'a' not being zero, but the
        // benefit is lost if 'b' is also tested.
        // See: https://github.com/OpenZeppelin/openzeppelin-contracts/pull/522
        if (a == 0) {
            return 0;
        }

        _require(!(a == -1 && b == _INT256_MIN), Errors.MUL_OVERFLOW);

        int256 c = a * b;
        _require(c / a == b, Errors.MUL_OVERFLOW);

        return c / ONE;
    }

    /**
     * @dev Returns e^x, assuming x is a fixed point numbers.
     */
    function exp(int256 x) internal pure returns (int256) {
        return LogExpMath.exp(x);
    }

    /**
     * @dev Returns ln(x), assuming x is a fixed point numbers.
     */
    function ln(int256 x) internal pure returns (int256) {
        return LogExpMath.ln(x);
    }
}
