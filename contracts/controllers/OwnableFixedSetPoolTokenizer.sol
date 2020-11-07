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

import "@openzeppelin/contracts/access/Ownable.sol";

import "./FixedSetPoolTokenizer.sol";

// Initial implementation implements a simple, pass-through sole proprietorship model
// for pool governance
contract OwnableFixedSetPoolTokenizer is FixedSetPoolTokenizer, Ownable {
    constructor(
        IVault _vault,
        address strategy,
        IVault.StrategyType strategyType
    ) FixedSetPoolTokenizer(_vault, strategy, strategyType) Ownable() {
        // solhint-disable-previous-line no-empty-blocks
    }

    function changePoolController(address controller) public onlyOwner {
        vault.setPoolController(poolId, controller);
    }

    function changePoolStrategy(
        address strategy,
        IVault.StrategyType strategyType
    ) public onlyOwner {
        vault.setPoolStrategy(poolId, strategy, strategyType);
    }

    function setInvestablePercentage(address token, uint128 percentage)
        public
        onlyOwner
    {
        vault.setInvestablePercentage(poolId, token, percentage);
    }

    function authorizePoolInvestmentManager(
        address token,
        address investmentManager
    ) public onlyOwner {
        vault.authorizePoolInvestmentManager(poolId, token, investmentManager);
    }
}
