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
pragma experimental ABIEncoderV2;

import "../lib/CircuitBreakerLib.sol";

contract MockCircuitBreakerLib {
    function getCircuitBreakerFields(bytes32 circuitBreakerState)
        external
        pure
        returns (uint256 bptPrice, uint256 weightComplement, uint256 lowerBound, uint256 upperBound)
    {
            return CircuitBreakerLib.getCircuitBreakerFields(circuitBreakerState);
    }

    function getCurrentCircuitBreakerBounds(bytes32 circuitBreakerState, uint256 currentWeightFactor)
        external
        pure
        returns (uint256, uint256)
    {
        return CircuitBreakerLib.getCurrentCircuitBreakerBounds(circuitBreakerState, currentWeightFactor);
    }

    function hasCircuitBreakerTripped(
        bytes32 circuitBreakerState,
        uint256 totalSupply,
        uint256 normalizedWeight,
        uint256 upscaledBalance
    ) external pure returns (bool, bool) {
        return CircuitBreakerLib.hasCircuitBreakerTripped(circuitBreakerState, totalSupply, normalizedWeight, upscaledBalance);
    }

    function setCircuitBreakerFields(uint256 bptPrice, uint256 weightComplement, uint256 lowerBound, uint256 upperBound)
        external
        pure
        returns (bytes32)
    {
        return CircuitBreakerLib.setCircuitBreakerFields(bptPrice, weightComplement, lowerBound, upperBound);
    }

    function updateBoundRatios(bytes32 circuitBreakerState, uint256 weightComplement) external pure returns (bytes32) {
        return CircuitBreakerLib.updateBoundRatios(circuitBreakerState, weightComplement);
    }

    function getBoundaryConversionRatios(
        uint256 lowerBoundPercentage,
        uint256 upperBoundPercentage,
        uint256 currentWeightComplement
    ) external pure returns (uint256, uint256) {
        return CircuitBreakerLib.getBoundaryConversionRatios(
            lowerBoundPercentage,
            upperBoundPercentage,
            currentWeightComplement
        );
    }
}
