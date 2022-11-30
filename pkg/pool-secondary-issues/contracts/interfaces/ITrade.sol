// Interface for trade
//"SPDX-License-Identifier: BUSL1.1"

pragma solidity 0.7.1;
pragma experimental ABIEncoderV2;

import "./IOrder.sol";

interface ITrade {

    /*enum DataType{ Bid, Offer, Trade, OpeningPrice }

    enum ExecutionStatus { Fill, PartialFill }

    enum SettlementType { STP, DP }*/

    struct trade{
        address transferor;
        address transferee;
        address security;
        uint256 price;
        uint256 askprice;
        address currency;
        IOrder.Order order;
        IOrder.OrderType otype;
        uint256 qty;
        uint dt;
        bytes32 pregRef;
        bytes32 cpregRef;
    }

    function tradeSettled(/*bytes32 tradeRef,*/ bytes32 partyRef, bytes32 counterpartyRef) external;

}