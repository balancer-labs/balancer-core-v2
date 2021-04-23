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

library WordCodec {
    int256 private constant _MASK_22 = 2**(22) - 1;
    int256 private constant _MASK_53 = 2**(53) - 1;
    uint256 private constant _MASK_31 = 2**(31) - 1;

    int256 private constant _MAX_INT_22 = 2**(21) - 1;
    int256 private constant _MAX_INT_53 = 2**(52) - 1;

    /**
     * @dev Encodes a 31-bits unsigned integer shifted an offset into a word
     */
    function encodeUint31(uint256 value, uint256 offset) internal pure returns (bytes32) {
        return bytes32(value << offset);
    }

    /**
     * @dev Encodes a 22-bits signed integer shifted an offset into a word
     */
    function encodeInt22(int256 value, uint256 offset) internal pure returns (bytes32) {
        return bytes32((value & _MASK_22) << offset);
    }

    /**
     * @dev Encodes a 53-bits signed integer shifted an offset into a word
     */
    function encodeInt53(int256 value, uint256 offset) internal pure returns (bytes32) {
        return bytes32((value & _MASK_53) << offset);
    }

    /**
     * @dev Decodes a 31-bits unsigned integer from a word discarding a number of least-significant bits.
     */
    function decodeUint31(bytes32 data, uint256 offset) internal pure returns (uint256) {
        return uint256(data >> offset) & _MASK_31;
    }

    /**
     * @dev Decodes a 22-bits signed integer from a word discarding a number of least-significant bits.
     */
    function decodeInt22(bytes32 data, uint256 offset) internal pure returns (int256) {
        int256 value = int256(data >> offset) & _MASK_22;
        // In case the decoded value is greater than the max positive integer that can be represented with 22 bits,
        // we know it was originally a negative integer. Therefore, we mask it to restore the sign in the 256 bits
        // representation.
        return value > _MAX_INT_22 ? (value | ~_MASK_22) : value;
    }

    /**
     * @dev Decodes a 53-bits signed integer from a word discarding a number of least-significant bits.
     */
    function decodeInt53(bytes32 data, uint256 offset) internal pure returns (int256) {
        int256 value = int256(data >> offset) & _MASK_53;
        // In case the decoded value is greater than the max positive integer that can be represented with 53 bits,
        // we know it was originally a negative integer. Therefore, we mask it to restore the sign in the 256 bits
        // representation.
        return value > _MAX_INT_53 ? (value | ~_MASK_53) : value;
    }
}
