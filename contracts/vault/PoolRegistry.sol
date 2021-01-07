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
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/utils/SafeCast.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./UserBalance.sol";

import "./balances/CashInvested.sol";
import "./balances/StandardPoolsBalance.sol";
import "./balances/SimplifiedQuotePoolsBalance.sol";
import "./balances/TwoTokenPoolsBalance.sol";

abstract contract PoolRegistry is
    ReentrancyGuard,
    UserBalance,
    StandardPoolsBalance,
    SimplifiedQuotePoolsBalance,
    TwoTokenPoolsBalance
{
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using SafeERC20 for IERC20;
    using CashInvested for bytes32;
    using FixedPoint for uint128;
    using FixedPoint for uint256;
    using SafeCast for uint256;
    using SafeCast for uint128;

    // Set with all pools in the system
    // TODO do we need this? can pools be deleted? if not, an array should be good enough
    EnumerableSet.Bytes32Set internal _pools;

    modifier withExistingPool(bytes32 poolId) {
        require(_pools.contains(poolId), "Nonexistent pool");
        _;
    }

    // investment managers are allowed to use a pools tokens for an investment
    mapping(bytes32 => mapping(IERC20 => address)) private _poolInvestmentManagers;

    event PoolInvestmentManagerSet(bytes32 indexed poolId, IERC20 indexed token, address indexed agent);

    modifier onlyPool(bytes32 poolId) {
        (address pool, ) = fromPoolId(poolId);
        require(pool == msg.sender, "Caller is not the pool");
        _;
    }

    function toPoolId(
        address pool,
        uint16 optimization,
        uint32 poolIndex
    ) public pure returns (bytes32) {
        uint256 serialized;
        serialized |= uint256(poolIndex) << (22 * 8);
        serialized |= uint256(optimization) << (20 * 8);
        serialized |= uint256(pool);
        return bytes32(serialized);
    }

    function fromPoolId(bytes32 serialized) public pure returns (address, PoolOptimization) {
        //|| 6 bytes empty | 4 bytes count of pools | 2 bytes optimization | 20 bytes pool ||
        address pool = address(uint256(serialized) & (2**(20 * 8) - 1));
        PoolOptimization optimization = PoolOptimization(uint256(serialized >> (20 * 8)) & (2**(2 * 8) - 1));

        return (pool, optimization);
    }

    // TODO: consider disallowing the same address to be used multiple times
    function registerPool(PoolOptimization optimization) external override returns (bytes32) {
        bytes32 poolId = toPoolId(msg.sender, uint16(optimization), uint32(_pools.length()));

        bool added = _pools.add(poolId);
        require(added, "Pool ID already exists");

        emit PoolCreated(poolId);

        return poolId;
    }

    function getNumberOfPools() external view override returns (uint256) {
        return _pools.length();
    }

    function getPoolIds(uint256 start, uint256 end) external view override returns (bytes32[] memory) {
        require((end >= start) && (end - start) <= _pools.length(), "Bad indices");

        bytes32[] memory poolIds = new bytes32[](end - start);
        for (uint256 i = 0; i < poolIds.length; ++i) {
            poolIds[i] = _pools.at(i + start);
        }

        return poolIds;
    }

    function getPoolTokens(bytes32 poolId) external view override withExistingPool(poolId) returns (IERC20[] memory) {
        (, PoolOptimization optimization) = fromPoolId(poolId);

        if (optimization == PoolOptimization.SIMPLIFIED_QUOTE) {
            return _getSimplifiedQuotePoolTokens(poolId);
        } else if (optimization == PoolOptimization.TWO_TOKEN) {
            return _getTwoTokenPoolTokens(poolId);
        } else {
            return _getStandardPoolTokens(poolId);
        }
    }

    /**
     * @dev Returns the balance for a token in a Pool.
     *
     * Requirements:
     *
     * - `token` must be in the Pool.
     */
    function _getPoolTokenBalance(
        bytes32 poolId,
        PoolOptimization optimization,
        IERC20 token
    ) internal view returns (bytes32) {
        if (optimization == PoolOptimization.SIMPLIFIED_QUOTE) {
            return _getSimplifiedQuotePoolBalance(poolId, token);
        } else if (optimization == PoolOptimization.TWO_TOKEN) {
            return _getTwoTokenPoolBalance(poolId, token);
        } else {
            return _getStandardPoolBalance(poolId, token);
        }
    }

    function getPoolTokenBalances(bytes32 poolId, IERC20[] calldata tokens)
        external
        view
        override
        withExistingPool(poolId)
        returns (uint256[] memory)
    {
        (, PoolOptimization optimization) = fromPoolId(poolId);

        uint256[] memory balances = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            balances[i] = _getPoolTokenBalance(poolId, optimization, tokens[i]).total();
        }

        return balances;
    }

    function getPool(bytes32 poolId)
        external
        view
        override
        withExistingPool(poolId)
        returns (address, PoolOptimization)
    {
        return fromPoolId(poolId);
    }

    function registerTokens(bytes32 poolId, IERC20[] calldata tokens)
        external
        override
        withExistingPool(poolId)
        onlyPool(poolId)
    {
        (, PoolOptimization optimization) = fromPoolId(poolId);
        if (optimization == PoolOptimization.TWO_TOKEN) {
            require(tokens.length == 2, "ERR_TOKENS_LENGTH_MUST_BE_2");
            _registerTwoTokenPoolTokens(poolId, tokens[0], tokens[1]);
        } else if (optimization == PoolOptimization.SIMPLIFIED_QUOTE) {
            _registerSimplifiedQuotePoolTokens(poolId, tokens);
        } else {
            _registerStandardPoolTokens(poolId, tokens);
        }

        emit TokensRegistered(poolId, tokens);
    }

    function unregisterTokens(bytes32 poolId, IERC20[] calldata tokens)
        external
        override
        withExistingPool(poolId)
        onlyPool(poolId)
    {
        (, PoolOptimization optimization) = fromPoolId(poolId);
        if (optimization == PoolOptimization.TWO_TOKEN) {
            require(tokens.length == 2, "ERR_TOKENS_LENGTH_MUST_BE_2");
            _unregisterTwoTokenPoolTokens(poolId, tokens[0], tokens[1]);
        } else if (optimization == PoolOptimization.SIMPLIFIED_QUOTE) {
            _unregisterSimplifiedQuotePoolTokens(poolId, tokens);
        } else {
            _unregisterStandardPoolTokens(poolId, tokens);
        }

        emit TokensUnregistered(poolId, tokens);
    }

    function addLiquidity(
        bytes32 poolId,
        address from,
        IERC20[] calldata tokens,
        uint256[] calldata amounts,
        bool withdrawFromUserBalance
    ) external override withExistingPool(poolId) onlyPool(poolId) {
        require(isAgentFor(from, msg.sender), "Caller is not an agent");
        require(tokens.length == amounts.length, "Tokens and total amounts length mismatch");

        // Receive all tokens
        _receiveLiquidity(from, tokens, amounts, withdrawFromUserBalance);

        // Grant tokens to pools - how this is done depends on the Pool optimization setting
        (, PoolOptimization optimization) = fromPoolId(poolId);
        if (optimization == PoolOptimization.TWO_TOKEN) {
            require(tokens.length == 2, "ERR_TOKENS_LENGTH_MUST_BE_2");
            _increaseTwoTokenPoolCash(poolId, tokens[0], amounts[0].toUint128(), tokens[1], amounts[1].toUint128());
        } else if (optimization == PoolOptimization.SIMPLIFIED_QUOTE) {
            _increaseSimplifiedQuotePoolCash(poolId, tokens, amounts);
        } else {
            _increaseStandardPoolCash(poolId, tokens, amounts);
        }
    }

    function _receiveLiquidity(
        address from,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bool withdrawFromUserBalance
    ) private {
        for (uint256 i = 0; i < tokens.length; ++i) {
            // Not technically necessary since the transfer call would fail
            IERC20 token = tokens[i];
            require(token != IERC20(0), "Token is the zero address");

            uint256 toReceive = amounts[i];
            if (toReceive > 0) {
                if (withdrawFromUserBalance) {
                    uint128 toWithdraw = uint128(Math.min(_userTokenBalance[from][token], toReceive));
                    _userTokenBalance[from][token] -= toWithdraw;
                    toReceive -= toWithdraw;
                }

                token.safeTransferFrom(from, address(this), toReceive);
            }
        }
    }

    function removeLiquidity(
        bytes32 poolId,
        address to,
        IERC20[] calldata tokens,
        uint256[] calldata amounts,
        bool depositToUserBalance
    ) external override withExistingPool(poolId) onlyPool(poolId) {
        require(tokens.length == amounts.length, "Tokens and total amounts length mismatch");

        // Deduct tokens from pools - how this is done depends on the Pool optimization setting
        (, PoolOptimization optimization) = fromPoolId(poolId);
        if (optimization == PoolOptimization.TWO_TOKEN) {
            require(tokens.length == 2, "ERR_TOKENS_LENGTH_MUST_BE_2");
            _decreaseTwoTokenPoolCash(poolId, tokens[0], amounts[0].toUint128(), tokens[1], amounts[1].toUint128());
        } else if (optimization == PoolOptimization.SIMPLIFIED_QUOTE) {
            _decreaseSimplifiedQuotePoolCash(poolId, tokens, amounts);
        } else {
            _decreaseStandardPoolCash(poolId, tokens, amounts);
        }

        // Send all tokens
        _withdrawLiquidity(to, tokens, amounts, depositToUserBalance);
    }

    function _withdrawLiquidity(
        address to,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bool depositToUserBalance
    ) private {
        for (uint256 i = 0; i < tokens.length; ++i) {
            // Not technically necessary since the transfer call would fail
            IERC20 token = tokens[i];
            require(token != IERC20(0), "Token is the zero address");

            uint256 amount256 = amounts[i];
            uint128 amount128 = amount256.toUint128();
            if (amount256 > 0) {
                if (depositToUserBalance) {
                    // Deposit tokens to the recipient's User Balance - the Vault's balance doesn't change
                    _userTokenBalance[to][token] = _userTokenBalance[to][token].add128(amount128);
                } else {
                    // Transfer the tokens to the recipient, charging the protocol exit fee
                    uint128 feeAmount = _calculateProtocolWithdrawFeeAmount(amount128);
                    _collectedProtocolFees[token] = _collectedProtocolFees[token].add(feeAmount);
                    token.safeTransfer(to, amount256.sub(feeAmount));
                }
            }
        }
    }

    // Investments

    modifier onlyPoolInvestmentManager(bytes32 poolId, IERC20 token) {
        require(_isPoolInvestmentManager(poolId, token, msg.sender), "SENDER_NOT_INVESTMENT_MANAGER");
        _;
    }

    function _isPoolInvested(
        bytes32 poolId,
        PoolOptimization optimization,
        IERC20 token
    ) internal view returns (bool) {
        if (optimization == PoolOptimization.SIMPLIFIED_QUOTE) {
            return _isSimplifiedQuotePoolInvested(poolId, token);
        } else if (optimization == PoolOptimization.TWO_TOKEN) {
            return _isTwoTokenPoolInvested(poolId, token);
        } else {
            return _isStandardPoolInvested(poolId, token);
        }
    }

    function setPoolInvestmentManager(
        bytes32 poolId,
        IERC20 token,
        address manager
    ) external override onlyPool(poolId) {
        require(_poolInvestmentManagers[poolId][token] == address(0), "CANNOT_RESET_INVESTMENT_MANAGER");
        require(manager != address(0), "Investment manager is the zero address");

        _poolInvestmentManagers[poolId][token] = manager;
        emit PoolInvestmentManagerSet(poolId, token, manager);
    }

    function getPoolInvestmentManager(bytes32 poolId, IERC20 token) external view override returns (address) {
        return _poolInvestmentManagers[poolId][token];
    }

    function isPoolInvestmentManager(
        bytes32 poolId,
        IERC20 token,
        address account
    ) external view returns (bool) {
        return _isPoolInvestmentManager(poolId, token, account);
    }

    function investPoolBalance(
        bytes32 poolId,
        IERC20 token,
        uint256 amount
    ) external override onlyPoolInvestmentManager(poolId, token) {
        (, PoolOptimization optimization) = fromPoolId(poolId);
        if (optimization == PoolOptimization.SIMPLIFIED_QUOTE) {
            _investSimplifiedQuotePoolCash(poolId, token, amount.toUint128());
        } else if (optimization == PoolOptimization.TWO_TOKEN) {
            _investTwoTokenPoolCash(poolId, token, amount.toUint128());
        } else {
            _investStandardPoolCash(poolId, token, amount.toUint128());
        }

        token.safeTransfer(msg.sender, amount);
    }

    function divestPoolBalance(
        bytes32 poolId,
        IERC20 token,
        uint256 amount
    ) external override onlyPoolInvestmentManager(poolId, token) {
        token.safeTransferFrom(msg.sender, address(this), amount);

        (, PoolOptimization optimization) = fromPoolId(poolId);
        if (optimization == PoolOptimization.SIMPLIFIED_QUOTE) {
            _divestSimplifiedQuotePoolCash(poolId, token, amount.toUint128());
        } else if (optimization == PoolOptimization.TWO_TOKEN) {
            _divestTwoTokenPoolCash(poolId, token, amount.toUint128());
        } else {
            _divestStandardPoolCash(poolId, token, amount.toUint128());
        }
    }

    function updateInvested(
        bytes32 poolId,
        IERC20 token,
        uint256 amount
    ) external override onlyPoolInvestmentManager(poolId, token) {
        (, PoolOptimization optimization) = fromPoolId(poolId);
        if (optimization == PoolOptimization.SIMPLIFIED_QUOTE) {
            _setSimplifiedQuotePoolInvestment(poolId, token, amount.toUint128());
        } else if (optimization == PoolOptimization.TWO_TOKEN) {
            _setTwoTokenPoolInvestment(poolId, token, amount.toUint128());
        } else {
            _setStandardPoolInvestment(poolId, token, amount.toUint128());
        }
    }

    function _isPoolInvestmentManager(
        bytes32 poolId,
        IERC20 token,
        address account
    ) internal view returns (bool) {
        return _poolInvestmentManagers[poolId][token] == account;
    }
}
