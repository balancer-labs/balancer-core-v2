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

import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/SafeERC20.sol";
import "./interfaces/IMultiRewards.sol";

// solhint-disable not-rely-on-time

/**
 * Scheduler for MultiRewards contract
 */
contract RewardsScheduler {
    using SafeERC20 for IERC20;

    IMultiRewards public multirewards;

    constructor(IMultiRewards _multirewards) {
        multirewards = _multirewards;
    }

    struct ScheduledReward {
        IERC20 pool;
        IERC20 rewardsToken;
        uint256 startTime;
        address rewarder;
        uint256 amount;
    }

    event RewardScheduled(bytes32 rewardId, address scheduler, address rewardsToken, uint256 startTime);
    event RewardUnscheduled(bytes32 rewardId, address scheduler, address rewardsToken, uint256 startTime);

    mapping(bytes32 => ScheduledReward) private _rewards;

    function poke(bytes32[] calldata rewardIds) external {
        for (uint256 r; r < rewardIds.length; r++) {
            bytes32 rewardId = rewardIds[r];
            ScheduledReward memory scheduledReward = _rewards[rewardId];

            require(scheduledReward.startTime != 0, "reward has not been created");
            require(scheduledReward.startTime <= block.timestamp, "reward cannot be started");

            scheduledReward.rewardsToken.approve(address(multirewards), scheduledReward.amount);
            multirewards.startScheduledReward(
                scheduledReward.pool,
                scheduledReward.rewardsToken,
                scheduledReward.amount,
                scheduledReward.rewarder
            );
            delete _rewards[rewardId];
        }
    }

    function getRewardId(
        IERC20 pool,
        IERC20 rewardsToken,
        address rewarder,
        uint256 startTime
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(pool, rewardsToken, rewarder, startTime));
    }

    function scheduleReward(
        IERC20 pool,
        IERC20 rewardsToken,
        uint256 amount,
        uint256 startTime
    ) public returns (bytes32 rewardId) {
        rewardId = getRewardId(pool, rewardsToken, msg.sender, startTime);
        require(startTime > block.timestamp, "reward can only be scheduled for the future");
        require(
            multirewards.isAllowlistedRewarder(pool, rewardsToken, msg.sender),
            "only allowlisted rewarders can schedule reward"
        );

        require(_rewards[rewardId].startTime == 0, "reward has already been scheduled");

        rewardsToken.safeTransferFrom(msg.sender, address(this), amount);

        _rewards[rewardId] = ScheduledReward({
            pool: pool,
            rewardsToken: rewardsToken,
            rewarder: msg.sender,
            amount: amount,
            startTime: startTime
        });

        emit RewardScheduled(rewardId, msg.sender, address(rewardsToken), startTime);
    }

    function unscheduleReward(bytes32 rewardId) external {
        ScheduledReward memory scheduledReward = _rewards[rewardId];

        require(scheduledReward.rewarder == msg.sender, "only rewarder can unschedule a reward");

        require(scheduledReward.startTime != 0, "reward has not been created");
        require(scheduledReward.startTime > block.timestamp, "reward cannot be cancelled once reward period has begun");

        IERC20 rewardsToken = IERC20(scheduledReward.rewardsToken);

        rewardsToken.safeTransfer(scheduledReward.rewarder, scheduledReward.amount);
        emit RewardUnscheduled(rewardId, scheduledReward.rewarder, address(rewardsToken), scheduledReward.startTime);
        delete _rewards[rewardId];
    }
}
