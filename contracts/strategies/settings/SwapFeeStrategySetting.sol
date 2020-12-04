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

import "@openzeppelin/contracts/utils/SafeCast.sol";

import "../../math/FixedPoint.sol";

contract SwapFeeStrategySetting {
    using SafeCast for uint256;
    using FixedPoint for uint256;
    using FixedPoint for uint128;

    uint256 public constant MIN_FEE = 0;
    uint256 public constant MAX_FEE = 10**17; // 0.1%

    uint256 private _mutableSwapFee;
    uint256 private immutable _immutableSwapFee;
    bool private immutable _isSwapFeeMutable;

    struct SwapFee {
        bool isMutable;
        uint256 value;
    }

    event SwapFeeSet(uint256 swapFee);

    constructor(SwapFee memory swapFee) {
        _isSwapFeeMutable = swapFee.isMutable;
        _immutableSwapFee = swapFee.isMutable ? 0 : swapFee.value;

        if (swapFee.isMutable) {
            _setSwapFee(swapFee.value);
        }
    }

    /**
     * @dev Set a new swap fee
     * @param newSwapFee New swap fee to be set
     */
    function setSwapFee(uint256 newSwapFee) external {
        // TODO: auth
        require(_isSwapFeeMutable, "Swap fee is not mutable");
        _setSwapFee(newSwapFee);
    }

    /**
     * @dev Returns the swap fee for the trading strategy
     */
    function getSwapFee() external view returns (uint256) {
        return _swapFee();
    }

    function _swapFee() internal view returns (uint256) {
        return _isSwapFeeMutable ? _mutableSwapFee : _immutableSwapFee;
    }

    function _addSwapFee(uint128 amount) internal view returns (uint128) {
        return amount.div128(FixedPoint.ONE.sub128(_swapFee().toUint128()));
    }

    function _subtractSwapFee(uint128 amount) internal view returns (uint128) {
        uint128 fees = amount.mul128(_swapFee().toUint128());
        return amount.sub128(fees);
    }

    function _setSwapFee(uint256 swapFee) private {
        _mutableSwapFee = swapFee;
        emit SwapFeeSet(swapFee);
    }
}
