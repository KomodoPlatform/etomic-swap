// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

contract EtomicSwap is ERC165, IERC1155Receiver, IERC721Receiver {
    enum PaymentState {
        Uninitialized,
        PaymentSent,
        ReceiverSpent,
        SenderRefunded
    }

    struct Payment {
        bytes20 paymentHash;
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
        bytes20 secretHash,
        uint64 lockTime
    ) external payable {
        require(receiver != address(0), "Receiver cannot be the zero address");
        require(msg.value > 0, "Payment amount must be greater than 0");
        require(
            payments[id].state == PaymentState.Uninitialized,
            "ETH payment already initialized"
        );

        bytes20 paymentHash = ripemd160(
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
        bytes20 secretHash,
        uint64 lockTime
    ) external payable {
        require(receiver != address(0), "Receiver cannot be the zero address");
        require(amount > 0, "Payment amount must be greater than 0");
        require(
            payments[id].state == PaymentState.Uninitialized,
            "ERC20 payment already initialized"
        );

        bytes20 paymentHash = ripemd160(
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
        IERC20 token = IERC20(tokenAddress);
        // Ensure that the token transfer from the sender to the contract is successful
        require(
            token.transferFrom(msg.sender, address(this), amount),
            "ERC20 transfer failed: Insufficient balance or allowance"
        );
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
        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.sender,
                sender,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(secret)))),
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
            IERC20 token = IERC20(tokenAddress);
            require(
                token.transfer(msg.sender, amount),
                "ERC20 transfer failed: Contract may lack balance or token transfer was rejected"
            );
        }
    }

    function receiverSpendErc721(
        bytes32 id,
        bytes32 secret,
        address tokenAddress,
        uint256 tokenId,
        address sender
    ) external {
        // Check if the payment state is PaymentSent
        require(
            payments[id].state == PaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );
        // Check if the function caller is an externally owned account (EOA)
        require(msg.sender == tx.origin, "Caller must be an EOA");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.sender,
                sender,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(secret)))),
                tokenAddress,
                tokenId
            )
        );
        require(paymentHash == payments[id].paymentHash, "Invalid paymentHash");

        // Effects
        payments[id].state = PaymentState.ReceiverSpent;

        // Event Emission
        emit ReceiverSpent(id, secret);

        // Interactions
        IERC721 token = IERC721(tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, tokenId);
    }

    function receiverSpendErc1155(
        bytes32 id,
        uint256 amount,
        bytes32 secret,
        address tokenAddress,
        uint256 tokenId,
        address sender
    ) external {
        // Check if the payment state is PaymentSent
        require(
            payments[id].state == PaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );
        // Check if the function caller is an externally owned account (EOA)
        require(msg.sender == tx.origin, "Caller must be an EOA");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.sender,
                sender,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(secret)))),
                tokenAddress,
                tokenId,
                amount
            )
        );
        require(paymentHash == payments[id].paymentHash, "Invalid paymentHash");

        // Effects
        payments[id].state = PaymentState.ReceiverSpent;

        // Event Emission
        emit ReceiverSpent(id, secret);

        // Interactions
        IERC1155 token = IERC1155(tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, tokenId, amount, "");
    }

    function senderRefund(
        bytes32 id,
        uint256 amount,
        bytes20 secretHash,
        address tokenAddress,
        address receiver
    ) external {
        require(
            payments[id].state == PaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );
        bytes20 paymentHash = ripemd160(
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
            IERC20 token = IERC20(tokenAddress);
            require(token.transfer(msg.sender, amount));
        }
    }

    function senderRefundErc721(
        bytes32 id,
        bytes20 secretHash,
        address tokenAddress,
        uint256 tokenId,
        address receiver
    ) external {
        require(
            payments[id].state == PaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );
        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                receiver,
                msg.sender,
                secretHash,
                tokenAddress,
                tokenId
            )
        );
        require(paymentHash == payments[id].paymentHash, "Invalid paymentHash");
        require(
            block.timestamp >= payments[id].lockTime,
            "Current timestamp didn't exceed payment lock time"
        );

        payments[id].state = PaymentState.SenderRefunded;

        emit SenderRefunded(id);

        IERC721 token = IERC721(tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, tokenId);
    }

    function senderRefundErc1155(
        bytes32 id,
        uint256 amount,
        bytes20 secretHash,
        address tokenAddress,
        uint256 tokenId,
        address receiver
    ) external {
        require(
            payments[id].state == PaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );
        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                receiver,
                msg.sender,
                secretHash,
                tokenAddress,
                tokenId,
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

        IERC1155 token = IERC1155(tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, tokenId, amount, "");
    }

    function onERC1155Received(
        address operator,
        address from,
        uint256 tokenId,
        uint256 value,
        bytes calldata data
    ) external override returns (bytes4) {
        // Decode the data to extract HTLC parameters
        (
            bytes32 id,
            address receiver,
            address tokenAddress,
            bytes20 secretHash,
            uint64 lockTime
        ) = abi.decode(data, (bytes32, address, address, bytes20, uint64));

        require(receiver != address(0), "Receiver must not be zero address");
        require(tokenAddress != address(0), "Token must not be zero address");
        require(
            msg.sender == tokenAddress,
            "Token address does not match sender"
        );
        require(operator == from, "Operator must be the sender");
        require(value > 0, "Value must be greater than 0");
        require(
            payments[id].state == PaymentState.Uninitialized,
            "ERC1155 payment must be Uninitialized"
        );
        require(!isContract(receiver), "Receiver cannot be a contract");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                receiver,
                from,
                secretHash,
                tokenAddress,
                tokenId,
                value
            )
        );

        payments[id] = Payment(paymentHash, lockTime, PaymentState.PaymentSent);
        emit PaymentSent(id);

        // Return this magic value to confirm receipt of ERC1155 token
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address, /* operator */
        address, /* from */
        uint256[] calldata, /* ids */
        uint256[] calldata, /* values */
        bytes calldata /* data */
    ) external pure override returns (bytes4) {
        revert("Batch transfers not supported");
    }

    function supportsInterface(bytes4 interfaceId)
    public
    view
    override(ERC165, IERC165)
    returns (bool)
    {
        return
            interfaceId == type(IERC1155Receiver).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external override returns (bytes4) {
        // Decode the data to extract HTLC parameters
        (
            bytes32 id,
            address receiver,
            address tokenAddress,
            bytes20 secretHash,
            uint64 lockTime
        ) = abi.decode(data, (bytes32, address, address, bytes20, uint64));

        require(receiver != address(0), "Receiver must not be zero address");
        require(tokenAddress != address(0), "Token must not be zero address");
        require(
            msg.sender == tokenAddress,
            "Token address does not match sender"
        );
        require(operator == from, "Operator must be the sender");
        require(
            payments[id].state == PaymentState.Uninitialized,
            "ERC721 payment must be Uninitialized"
        );
        require(!isContract(receiver), "Receiver cannot be a contract");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(receiver, from, secretHash, tokenAddress, tokenId)
        );

        payments[id] = Payment(paymentHash, lockTime, PaymentState.PaymentSent);
        emit PaymentSent(id);

        // Return this magic value to confirm receipt of ERC721 token
        return this.onERC721Received.selector;
    }

    function isContract(address account) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(account)
        }
        return size > 0;
    }
}
