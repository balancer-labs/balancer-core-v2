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

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../math/FixedPoint.sol";

import "../vault/IFlashLoanReceiver.sol";
import "../vault/IVault.sol";

import "./TestToken.sol";

contract MockFlashLoanReceiver is IFlashLoanReceiver {
    using FixedPoint for uint256;
    using SafeERC20 for IERC20;

    address public immutable vault;
    bool public repayLoan;
    bool public repayInExcess;
    bool public reenter;

    constructor(address _vault) {
        vault = _vault;
        repayLoan = true;
        repayInExcess = false;
        reenter = false;
    }

    function setRepayLoan(bool _repayLoan) public {
        repayLoan = _repayLoan;
    }

    function setRepayInExcess(bool _repayInExcess) public {
        repayInExcess = _repayInExcess;
    }

    function setReenter(bool _reenter) public {
        reenter = _reenter;
    }

    // Repays loan unless setRepayLoan was called with 'false'
    function receiveFlashLoan(
        IERC20 token,
        uint256 amount,
        uint256 feeAmount,
        bytes calldata receiverData
    ) external override {
        require(msg.sender == vault, "Flash loan callbacks can only be called by the Vault");

        require(token.balanceOf(address(this)) == amount, "Invalid balance, was the flashLoan successful?");

        if (reenter) {
            IVault(msg.sender).flashLoan(IFlashLoanReceiver(address(this)), token, amount, receiverData);
        }

        TestToken(address(token)).mint(address(this), repayInExcess ? feeAmount.add(1) : feeAmount);

        uint256 totalDebt = amount.add(feeAmount);

        if (!repayLoan) {
            totalDebt = totalDebt.sub(1);
        } else if (repayInExcess) {
            totalDebt = totalDebt.add(1);
        }

        token.safeTransfer(vault, totalDebt);
    }
}
