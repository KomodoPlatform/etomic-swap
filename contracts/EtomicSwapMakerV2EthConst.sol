// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract EtomicSwapMakerV2EthConst {
    using SafeERC20 for IERC20;

    address constant ETH_PLACEHOLDER_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    enum MakerPaymentState {
        Uninitialized,
        PaymentSent,
        TakerSpent,
        MakerRefunded
    }

    struct MakerPayment {
        bytes20 paymentHash;
        uint32 paymentLockTime;
        MakerPaymentState state;
    }

    event MakerPaymentSent(bytes32 id);
    event MakerPaymentSpent(bytes32 id);
    event MakerPaymentRefundedTimelock(bytes32 id);
    event MakerPaymentRefundedSecret(bytes32 id);

    mapping(bytes32 => MakerPayment) public makerPayments;

    // 0x7466be60
    function ethMakerPayment(
        bytes32 id,
        address taker,
        bytes32 takerSecretHash,
        bytes32 makerSecretHash,
        uint32 paymentLockTime
    ) external payable {
        require(
            makerPayments[id].state == MakerPaymentState.Uninitialized,
            "Maker payment is already initialized"
        );
        require(taker != address(0), "Taker must not be zero address");
        require(msg.value > 0, "ETH value must be greater than zero");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.value,
                taker,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                ETH_PLACEHOLDER_ADDRESS
            )
        );

        makerPayments[id] = MakerPayment(
            paymentHash,
            paymentLockTime,
            MakerPaymentState.PaymentSent
        );

        emit MakerPaymentSent(id);
    }

    // 0xa53bc126
    function erc20MakerPayment(
        bytes32 id,
        uint256 amount,
        address tokenAddress,
        address taker,
        bytes32 takerSecretHash,
        bytes32 makerSecretHash,
        uint32 paymentLockTime
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.Uninitialized,
            "Maker payment is already initialized"
        );
        require(amount > 0, "Amount must not be zero");
        require(taker != address(0), "Taker must not be zero address");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                taker,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                tokenAddress
            )
        );

        makerPayments[id] = MakerPayment(
            paymentHash,
            paymentLockTime,
            MakerPaymentState.PaymentSent
        );

        emit MakerPaymentSent(id);

        // Now performing the external interaction
        IERC20 token = IERC20(tokenAddress);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    // 0x1299a27a
    function spendMakerPayment(
        bytes32 id,
        uint256 amount,
        address maker,
        bytes32 takerSecretHash,
        bytes32 makerSecret,
        address tokenAddress
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                msg.sender,
                maker,
                takerSecretHash,
                sha256(abi.encodePacked(makerSecret)),
                tokenAddress
            )
        );
        require(
            paymentHash == makerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        makerPayments[id].state = MakerPaymentState.TakerSpent;

        emit MakerPaymentSpent(id);

        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
        } else {
            IERC20 token = IERC20(tokenAddress);
            token.safeTransfer(msg.sender, amount);
        }
    }

    // 0x9b949dee
    function refundMakerPaymentTimelock(
        bytes32 id,
        uint256 amount,
        address taker,
        bytes32 takerSecretHash,
        bytes32 makerSecretHash,
        address tokenAddress
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                taker,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                tokenAddress
            )
        );

        require(
            paymentHash == makerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        require(
            block.timestamp >= makerPayments[id].paymentLockTime,
            "Current timestamp didn't exceed payment refund lock time"
        );

        makerPayments[id].state = MakerPaymentState.MakerRefunded;

        emit MakerPaymentRefundedTimelock(id);

        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
        } else {
            IERC20 token = IERC20(tokenAddress);
            token.safeTransfer(msg.sender, amount);
        }
    }

    // 0x74a4788a
    function refundMakerPaymentSecret(
        bytes32 id,
        uint256 amount,
        address taker,
        bytes32 takerSecret,
        bytes32 makerSecretHash,
        address tokenAddress
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                taker,
                msg.sender,
                sha256(abi.encodePacked(takerSecret)),
                makerSecretHash,
                tokenAddress
            )
        );

        require(
            paymentHash == makerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        makerPayments[id].state = MakerPaymentState.MakerRefunded;

        emit MakerPaymentRefundedSecret(id);

        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
        } else {
            IERC20 token = IERC20(tokenAddress);
            token.safeTransfer(msg.sender, amount);
        }
    }
}
