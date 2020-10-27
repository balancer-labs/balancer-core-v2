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

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/SafeCast.sol";

import "hardhat/console.sol";

import "./PoolRegistry.sol";

import "./ISwapCaller.sol";

import "./LogExpMath.sol";

import "./strategies/ITradingStrategy.sol";
import "./strategies/IPairTradingStrategy.sol";
import "./strategies/ITupleTradingStrategy.sol";

import "./math/FixedPoint.sol";

contract Vault is IVault, PoolRegistry {
    using BalanceLib for BalanceLib.Balance;
    using EnumerableSet for EnumerableSet.AddressSet;
    using FixedPoint for uint256;
    using FixedPoint for uint128;
    using SafeCast for uint256;

    // The vault's accounted-for balance for each token. These include:
    //  * tokens in pools
    //  * tokens stored as user balance
    mapping(address => BalanceLib.Balance) private _vaultTokenBalance; // token -> vault balance

    mapping(address => mapping(address => uint256)) private _userTokenBalance; // user -> token -> user balance
    // operators are allowed to use a user's tokens in a swap
    mapping(address => EnumerableSet.AddressSet) private _userOperators;

    event Deposited(
        address indexed depositor,
        address indexed user,
        address indexed token,
        uint256 amount
    );

    event Withdrawn(
        address indexed user,
        address indexed recipient,
        address indexed token,
        uint256 amount
    );

    event AuthorizedOperator(address indexed user, address indexed operator);
    event RevokedOperator(address indexed user, address indexed operator);

    function getUserTokenBalance(address user, address token)
        public
        view
        returns (uint256)
    {
        return _userTokenBalance[user][token];
    }

    function deposit(
        address token,
        uint256 amount,
        address user
    ) external {
        _userTokenBalance[user][token] = _userTokenBalance[user][token].add(
            amount
        );

        // TODO: use ISwapCaller callback?
        _pullUnderlying(token, msg.sender, amount.toUint128());

        emit Deposited(msg.sender, user, token, amount);
    }

    function withdraw(
        address token,
        uint128 amount,
        address recipient
    ) external {
        require(
            _userTokenBalance[msg.sender][token] >= amount,
            "Vault: withdraw amount exceeds balance"
        );

        _userTokenBalance[msg.sender][token] -= amount;

        _pushUnderlying(token, recipient, amount);

        emit Withdrawn(msg.sender, recipient, token, amount);
    }

    function authorizeOperator(address operator) external {
        if (_userOperators[msg.sender].add(operator)) {
            emit AuthorizedOperator(msg.sender, operator);
        }
    }

    function revokeOperator(address operator) external {
        if (_userOperators[msg.sender].remove(operator)) {
            emit RevokedOperator(msg.sender, operator);
        }
    }

    function isOperatorFor(address user, address operator)
        public
        view
        returns (bool)
    {
        return (user == operator) || _userOperators[user].contains(operator);
    }

    function getUserTotalOperators(address user)
        external
        view
        returns (uint256)
    {
        return _userOperators[user].length();
    }

    function getUserOperators(
        address user,
        uint256 start,
        uint256 end
    ) external view returns (address[] memory) {
        // Ideally we'd use a native implemenation: see
        // https://github.com/OpenZeppelin/openzeppelin-contracts/issues/2390
        address[] memory operators = new address[](
            _userOperators[user].length()
        );

        for (uint256 i = start; i < end; ++i) {
            operators[i] = _userOperators[user].at(i);
        }

        return operators;
    }

    // Bind does not lock because it jumps to `rebind`, which does
    function bind(
        bytes32 poolId,
        address token,
        uint256 balance
    ) external override _logs_ {
        require(msg.sender == pools[poolId].controller, "ERR_NOT_CONTROLLER");
        require(!poolRecords[poolId][token].bound, "ERR_IS_BOUND");

        require(
            pools[poolId].tokens.length < MAX_BOUND_TOKENS,
            "ERR_MAX_TOKENS"
        );

        poolRecords[poolId][token] = Record({
            bound: true,
            index: uint8(pools[poolId].tokens.length)
        });
        pools[poolId].tokens.push(token);
        rebind(poolId, token, balance);
    }

    function rebind(
        bytes32 poolId,
        address token,
        uint256 balance
    ) public override _logs_ _lock_ {
        require(msg.sender == pools[poolId].controller, "ERR_NOT_CONTROLLER");
        require(poolRecords[poolId][token].bound, "ERR_NOT_BOUND");

        require(balance >= MIN_BALANCE, "ERR_MIN_BALANCE");

        // Adjust the balance record and actual token balance
        uint128 oldBalance = _poolTokenBalance[poolId][token].total();
        _poolTokenBalance[poolId][token].cash =
            balance.toUint128() -
            _poolTokenBalance[poolId][token].invested;

        if (balance > oldBalance) {
            _pullUnderlying(
                token,
                msg.sender,
                balance.toUint128().sub128(oldBalance)
            );
        } else if (balance < oldBalance) {
            require(
                balance >= _poolTokenBalance[poolId][token].invested,
                "Not enough cash to rebind, divest appropriately"
            );

            // TODO: charge exit fee
            _pushUnderlying(
                token,
                msg.sender,
                oldBalance.sub128(balance.toUint128())
            );
        }
    }

    function unbind(bytes32 poolId, address token)
        external
        override
        _logs_
        _lock_
    {
        require(msg.sender == pools[poolId].controller, "ERR_NOT_CONTROLLER");
        require(poolRecords[poolId][token].bound, "ERR_NOT_BOUND");

        require(
            _poolTokenBalance[poolId][token].invested == 0,
            "Withdraw all pool token investments before unbinding"
        );
        uint128 tokenBalance = _poolTokenBalance[poolId][token].total();

        // Swap the token-to-unbind with the last token,
        // then delete the last token
        uint8 index = poolRecords[poolId][token].index;
        uint256 last = pools[poolId].tokens.length - 1;
        pools[poolId].tokens[index] = pools[poolId].tokens[last];
        poolRecords[poolId][pools[poolId].tokens[index]].index = index;
        pools[poolId].tokens.pop();
        poolRecords[poolId][token] = Record({ bound: false, index: 0 });

        // TODO: charge exit fee
        _pushUnderlying(token, msg.sender, tokenBalance);
    }

    function batchSwap(
        Diff[] memory diffs,
        Swap[] memory swaps,
        FundsIn calldata fundsIn,
        FundsOut calldata fundsOut
    ) external override {
        //TODO: avoid reentrancy

        // TODO: check tokens in diffs are unique. Is this necessary? Would avoid multiple valid diff
        // indexes pointing to the same token.
        // A simple way to implement this is to require the addresses to be sorted, and require strict
        // inequality

        for (uint256 i = 0; i < diffs.length; ++i) {
            require(diffs[i].vaultDelta == 0, "Bad workspace");
        }

        // TODO: check each pool only appears in a single swap. Might be overly restrictive, but easy
        // to implement (require swaps array to be sorted by poolId).

        // Steps 1, 2 & 3:
        //  - validate hints
        //  - check new pool balances are valid
        //  - accumulate token diffs
        //  - update pool balances

        for (uint256 i = 0; i < swaps.length; ++i) {
            Swap memory swap = swaps[i];

            require(swap.tokenA.delta != 0, "Token A NOOP");
            require(swap.tokenB.delta != 0, "Token B NOOP");

            address tokenA = diffs[swap.tokenA.tokenDiffIndex].token;
            address tokenB = diffs[swap.tokenB.tokenDiffIndex].token;

            // 1.2: Accumulate token diffs
            diffs[swap.tokenA.tokenDiffIndex].vaultDelta += swap.tokenA.delta;
            diffs[swap.tokenB.tokenDiffIndex].vaultDelta += swap.tokenB.delta;

            (
                uint128 tokenAFinalBalance,
                uint128 tokenBFinalBalance
            ) = _validateSwap(swap, tokenA, tokenB);

            // 3: update pool balances
            _poolTokenBalance[swap.poolId][tokenA].cash =
                tokenAFinalBalance -
                _poolTokenBalance[swap.poolId][tokenA].invested;
            _poolTokenBalance[swap.poolId][tokenB].cash =
                tokenBFinalBalance -
                _poolTokenBalance[swap.poolId][tokenB].invested;
        }

        // Step 4: measure current balance for tokens that need to be received
        for (uint256 i = 0; i < diffs.length; ++i) {
            Diff memory diff = diffs[i];

            if (diff.vaultDelta > 0) {
                // Change positive deltas into expected final balances
                diff.vaultDelta += int256(
                    IERC20(diff.token).balanceOf(address(this))
                ); // TODO: check overflows
            }
        }

        // Call into sender to trigger token receipt
        ISwapCaller(msg.sender).sendTokens(fundsIn.callbackData);

        // Step 5: check tokens have been received
        for (uint256 i = 0; i < diffs.length; ++i) {
            Diff memory diff = diffs[i];

            if (diff.vaultDelta > 0) {
                uint128 newBalance = IERC20(diff.token)
                    .balanceOf(address(this))
                    .toUint128();

                if (uint128(diff.vaultDelta) > newBalance) {
                    uint256 missing = uint256(diff.vaultDelta) - newBalance;

                    require(
                        isOperatorFor(fundsIn.withdrawFrom, msg.sender),
                        "Caller is not operator"
                    );
                    require(
                        _userTokenBalance[fundsIn.withdrawFrom][diff.token] >=
                            missing,
                        "ERR_INVALID_DEPOSIT"
                    );

                    _userTokenBalance[fundsIn.withdrawFrom][diff
                        .token] -= missing;
                }

                // Update token balance
                // TODO: only update based on how many tokens were received
                _vaultTokenBalance[diff.token].cash = newBalance.sub128(
                    _vaultTokenBalance[diff.token].invested
                );
            }
        }

        // Step 6: send out tokens to send
        for (uint256 i = 0; i < diffs.length; ++i) {
            Diff memory diff = diffs[i];

            if (diff.vaultDelta < 0) {
                // Make delta positive
                uint128 amount = uint128(-diff.vaultDelta);

                if (fundsOut.transferToRecipient) {
                    // Actually transfer the tokens to the recipient
                    _pushUnderlying(diff.token, fundsOut.recipient, amount);
                } else {
                    // Allocate tokens to the recipient as user balance - the vault's balance doesn't change
                    _userTokenBalance[fundsOut.recipient][diff
                        .token] = _userTokenBalance[fundsOut.recipient][diff
                        .token]
                        .add(amount);
                }
            }
        }
    }

    function _validateSwap(
        Swap memory swap,
        address tokenA,
        address tokenB
    ) private returns (uint128, uint128) {
        // Make deltas positive
        uint128 amountIn = swap.tokenA.delta > 0
            ? uint256(swap.tokenA.delta).toUint128()
            : uint256(-swap.tokenA.delta).toUint128();
        uint128 amountOut = swap.tokenB.delta > 0
            ? uint256(swap.tokenB.delta).toUint128()
            : uint256(-swap.tokenB.delta).toUint128();

        StrategyType strategyType = pools[swap.poolId].strategyType;

        if (strategyType == StrategyType.PAIR) {
            return
                _validatePairStrategySwap(
                    swap.poolId,
                    tokenA,
                    tokenB,
                    amountIn,
                    amountOut,
                    IPairTradingStrategy(pools[swap.poolId].strategy)
                );
        } else if (strategyType == StrategyType.TUPLE) {
            return
                _validateTupleStrategySwap(
                    ITradingStrategy.Swap({
                        poolId: swap.poolId,
                        tokenIn: tokenA,
                        tokenOut: tokenB,
                        amountIn: amountIn,
                        amountOut: amountOut
                    }),
                    ITupleTradingStrategy(pools[swap.poolId].strategy)
                );
        } else {
            revert("Unknown strategy type");
        }
    }

    function _validatePairStrategySwap(
        bytes32 poolId,
        address tokenA,
        address tokenB,
        uint128 amountIn,
        uint128 amountOut,
        IPairTradingStrategy strategy
    ) private returns (uint128, uint128) {
        uint128 poolTokenABalance = _poolTokenBalance[poolId][tokenA].total();
        require(poolTokenABalance > 0, "Token A not in pool");

        uint128 poolTokenBBalance = _poolTokenBalance[poolId][tokenB].total();
        require(poolTokenBBalance > 0, "Token B not in pool");

        (bool success, ) = strategy.validatePair(
            ITradingStrategy.Swap({
                poolId: poolId,
                tokenIn: tokenA,
                tokenOut: tokenB,
                amountIn: amountIn,
                amountOut: amountOut
            }),
            poolTokenABalance,
            poolTokenBBalance
        );
        require(success, "pair validation failed");

        return (
            // TODO: make sure the protocol fees are not accounted for!
            // currentBalances[indexIn] + amountIn - bmul(feeAmountIn, 0), // feeAmountIn * protocolfee
            poolTokenABalance + amountIn,
            poolTokenBBalance - amountOut
        );
    }

    function _validateTupleStrategySwap(
        ITradingStrategy.Swap memory swap,
        ITupleTradingStrategy strategy
    ) private returns (uint128, uint128) {
        uint128[] memory currentBalances = new uint128[](
            pools[swap.poolId].tokens.length
        );

        uint256 indexIn;
        uint256 indexOut;

        for (uint256 i = 0; i < pools[swap.poolId].tokens.length; i++) {
            address token = pools[swap.poolId].tokens[i];
            currentBalances[i] = _poolTokenBalance[swap.poolId][token].total();
            require(currentBalances[i] > 0, "Token A not in pool");

            if (token == swap.tokenIn) {
                indexIn = i;
            } else if (token == swap.tokenOut) {
                indexOut = i;
            }
        }

        (bool success, ) = strategy.validateTuple(
            swap,
            currentBalances,
            indexIn,
            indexOut
        );
        require(success, "invariant validation failed");

        return (
            // TODO: make sure the protocol fees are not accounted for!
            // currentBalances[indexIn] + amountIn - bmul(feeAmountIn, 0), // feeAmountIn * protocolfee
            currentBalances[indexIn] + swap.amountIn,
            currentBalances[indexOut] - swap.amountOut
        );
    }

    function addInitialLiquidity(
        bytes32 poolId,
        address[] calldata initialTokens,
        uint256[] calldata initialBalances
    ) external override onlyPoolController(poolId) {
        pools[poolId].tokens = initialTokens;

        for (uint256 i = 0; i < initialTokens.length; ++i) {
            address t = initialTokens[i];
            uint128 tokenAmountIn = initialBalances[i].toUint128();
            require(tokenAmountIn != 0, "ERR_MATH_APPROX");
            require(
                IERC20(t).balanceOf(address(this)).sub(_allocatedBalances[t]) >=
                    tokenAmountIn,
                "INSUFFICIENT UNALLOCATED BALANCE"
            );

            _poolTokenBalance[poolId][t].cash = tokenAmountIn;
            _allocatedBalances[t] = _allocatedBalances[t].add(tokenAmountIn);
        }
    }

    function addLiquidity(bytes32 poolId, uint256[] calldata amountsIn)
        external
        override
        onlyPoolController(poolId)
    {
        Pool memory pool = pools[poolId];

        for (uint256 i = 0; i < pool.tokens.length; ++i) {
            address t = pool.tokens[i];
            uint128 bal = _poolTokenBalance[poolId][t].cash;
            uint128 tokenAmountIn = amountsIn[i].toUint128();
            require(tokenAmountIn != 0, "ERR_MATH_APPROX");
            require(
                IERC20(t).balanceOf(address(this)).sub(_allocatedBalances[t]) >=
                    tokenAmountIn,
                "INSUFFICIENT UNALLOCATED BALANCE"
            );

            _poolTokenBalance[poolId][t].cash = bal.add128(tokenAmountIn);
            _allocatedBalances[t] = _allocatedBalances[t].add(tokenAmountIn);
        }
    }

    function removeLiquidity(
        bytes32 poolId,
        address recipient,
        uint256[] calldata amountsOut
    ) external override onlyPoolController(poolId) {
        Pool memory pool = pools[poolId];

        for (uint256 i = 0; i < pool.tokens.length; ++i) {
            address t = pool.tokens[i];
            uint128 cashBal = _poolTokenBalance[poolId][t].cash;

            uint128 tokenAmountOut = amountsOut[i].toUint128();
            require(
                _poolTokenBalance[poolId][t].cash > tokenAmountOut,
                "insufficient cash balance for liquidity withdrawal"
            );
            require(tokenAmountOut != 0, "ERR_MATH_APPROX");
            require(
                _allocatedBalances[t] >= tokenAmountOut,
                "INSUFFICIENT BALANCE TO WITHDRAW"
            );

            bool xfer = IERC20(t).transfer(recipient, tokenAmountOut);
            require(xfer, "ERR_ERC20_FALSE");

            _poolTokenBalance[poolId][t].cash = cashBal.sub128(tokenAmountOut);
            _allocatedBalances[t] = _allocatedBalances[t].sub(tokenAmountOut);
        }
    }

    // 'Underlying' token-manipulation functions make external calls but are NOT locked
    // You must `_lock_` or otherwise ensure reentry-safety

    function _pullUnderlying(
        address erc20,
        address from,
        uint128 amount
    ) internal {
        bool xfer = IERC20(erc20).transferFrom(from, address(this), amount);
        require(xfer, "ERR_ERC20_FALSE");

        // TODO: What assumptions do we make when pulling? Should we check token.balanceOf(this)
        // increased by toPull?
        _vaultTokenBalance[erc20].cash += amount;
    }

    function _pushUnderlying(
        address erc20,
        address to,
        uint128 amount
    ) internal {
        // TODO: What assumptions do we make when pushing? Should we check token.balanceOf(this)
        // decreased by toPull?
        require(
            _vaultTokenBalance[erc20].cash >= amount,
            "insufficient cash balance to push"
        );
        _vaultTokenBalance[erc20].cash -= amount;

        bool xfer = IERC20(erc20).transfer(to, amount);
        require(xfer, "ERR_ERC20_FALSE");
    }
}
