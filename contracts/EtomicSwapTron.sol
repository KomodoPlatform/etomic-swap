// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract EtomicSwapTron {
    using SafeERC20 for IERC20;

    enum PaymentState {
        Uninitialized,
        PaymentSent,
        ReceiverSpent,
        SenderRefunded
    }

    struct Payment {
        bytes32 paymentHash;
        uint64 lockTime;
        PaymentState state;
    }

    mapping(bytes32 => Payment) public payments;

    event PaymentSent(bytes32 id);
    event ReceiverSpent(bytes32 id, bytes32 secret);
    event SenderRefunded(bytes32 id);

    constructor() {}

    function ethPayment(
        bytes32 id,
        address receiver,
        bytes32 secretHash,
        uint64 lockTime
    ) external payable {
        require(receiver != address(0), "Receiver cannot be the zero address");
        require(msg.value > 0, "Payment amount must be greater than 0");
        require(
            payments[id].state == PaymentState.Uninitialized,
            "ETH payment already initialized"
        );

        bytes32 paymentHash = sha256(
            abi.encodePacked(
                receiver,
                msg.sender,
                secretHash,
                address(0),
                msg.value
            )
        );

        payments[id] = Payment(paymentHash, lockTime, PaymentState.PaymentSent);

        emit PaymentSent(id);
    }

    function erc20Payment(
        bytes32 id,
        uint256 amount,
        address tokenAddress,
        address receiver,
        bytes32 secretHash,
        uint64 lockTime
    ) external {
        require(receiver != address(0), "Receiver cannot be the zero address");
        require(tokenAddress != address(0), "Token address cannot be zero");
        require(amount > 0, "Payment amount must be greater than 0");
        require(
            payments[id].state == PaymentState.Uninitialized,
            "ERC20 payment already initialized"
        );

        bytes32 paymentHash = sha256(
            abi.encodePacked(
                receiver,
                msg.sender,
                secretHash,
                tokenAddress,
                amount
            )
        );

        payments[id] = Payment(paymentHash, lockTime, PaymentState.PaymentSent);

        // Emitting the event before making the external call
        emit PaymentSent(id);

        // Now performing the external interaction
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), amount);
    }

    function receiverSpend(
        bytes32 id,
        uint256 amount,
        bytes32 secret,
        address tokenAddress,
        address sender
    ) external {
        // Checks
        require(
            payments[id].state == PaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );
        bytes32 paymentHash = sha256(
            abi.encodePacked(
                msg.sender,
                sender,
                sha256(abi.encodePacked(secret)),
                tokenAddress,
                amount
            )
        );
        require(paymentHash == payments[id].paymentHash, "Invalid paymentHash");

        // Effects
        payments[id].state = PaymentState.ReceiverSpent;

        // Event Emission
        emit ReceiverSpent(id, secret);

        // Interactions
        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
        } else {
            // Some tokens (e.g. USDT on TRON) return bool(false) from
            // transfer() even on success.  We ignore the bool return
            // entirely and verify via the receiver's balance change.
            uint256 balanceBefore = IERC20(tokenAddress).balanceOf(msg.sender);
            IERC20(tokenAddress).transfer(msg.sender, amount);
            require(
                IERC20(tokenAddress).balanceOf(msg.sender) == balanceBefore + amount,
                "Token transfer did not increase balance"
            );
        }
    }

    function senderRefund(
        bytes32 id,
        uint256 amount,
        bytes32 secretHash,
        address tokenAddress,
        address receiver
    ) external {
        require(
            payments[id].state == PaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes32 paymentHash = sha256(
            abi.encodePacked(
                receiver,
                msg.sender,
                secretHash,
                tokenAddress,
                amount
            )
        );
        require(paymentHash == payments[id].paymentHash, "Invalid paymentHash");
        require(
            block.timestamp >= payments[id].lockTime,
            "Current timestamp didn't exceed payment lock time"
        );

        payments[id].state = PaymentState.SenderRefunded;

        emit SenderRefunded(id);

        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
        } else {
            uint256 balanceBefore = IERC20(tokenAddress).balanceOf(msg.sender);
            IERC20(tokenAddress).transfer(msg.sender, amount);
            require(
                IERC20(tokenAddress).balanceOf(msg.sender) == balanceBefore + amount,
                "Token transfer did not increase balance"
            );
        }
    }
}
