// SPDX-License-Identifier: MIT

pragma solidity ^0.8.23;
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
        bytes32 _id,
        address _receiver,
        bytes20 _secretHash,
        uint64 _lockTime
    ) external payable {
        require(
            _receiver != address(0) &&
            msg.value > 0 &&
            payments[_id].state == PaymentState.Uninitialized
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                _receiver,
                msg.sender,
                _secretHash,
                address(0),
                msg.value
            )
        );

        payments[_id] = Payment(
            paymentHash,
            _lockTime,
            PaymentState.PaymentSent
        );

        emit PaymentSent(_id);
    }

    function erc20Payment(
        bytes32 _id,
        uint256 _amount,
        address _tokenAddress,
        address _receiver,
        bytes20 _secretHash,
        uint64 _lockTime
    ) external payable {
        require(
            _receiver != address(0) &&
            _amount > 0 &&
            payments[_id].state == PaymentState.Uninitialized
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                _receiver,
                msg.sender,
                _secretHash,
                _tokenAddress,
                _amount
            )
        );

        payments[_id] = Payment(
            paymentHash,
            _lockTime,
            PaymentState.PaymentSent
        );

        IERC20 token = IERC20(_tokenAddress);
        require(token.transferFrom(msg.sender, address(this), _amount));
        emit PaymentSent(_id);
    }

    function erc721Payment(
        bytes32 _id,
        address _receiver,
        address _tokenAddress,
        uint256 _tokenId,
        bytes20 _secretHash,
        uint64 _lockTime
    ) external {
        require(
            _receiver != address(0) &&
            _tokenAddress != address(0) &&
            payments[_id].state == PaymentState.Uninitialized
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                _receiver,
                msg.sender,
                _secretHash,
                _tokenAddress,
                _tokenId
            )
        );

        payments[_id] = Payment(
            paymentHash,
            _lockTime,
            PaymentState.PaymentSent
        );

        IERC721 token = IERC721(_tokenAddress);
        token.safeTransferFrom(msg.sender, address(this), _tokenId);
        emit PaymentSent(_id);
    }

    function erc1155Payment(
        bytes32 _id,
        uint256 _amount,
        address _receiver,
        address _tokenAddress,
        uint256 _tokenId,
        bytes20 _secretHash,
        uint64 _lockTime
    ) external {
        require(
            _receiver != address(0) &&
            _tokenAddress != address(0) &&
            _amount > 0 &&
            payments[_id].state == PaymentState.Uninitialized
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                _receiver,
                msg.sender,
                _secretHash,
                _tokenAddress,
                _tokenId,
                _amount
            )
        );

        payments[_id] = Payment(
            paymentHash,
            _lockTime,
            PaymentState.PaymentSent
        );

        IERC1155 token = IERC1155(_tokenAddress);
        token.safeTransferFrom(
            msg.sender,
            address(this),
            _tokenId,
            _amount,
            ""
        );
        emit PaymentSent(_id);
    }

    function receiverSpend(
        bytes32 _id,
        uint256 _amount,
        bytes32 _secret,
        address _tokenAddress,
        address _sender
    ) external {
        require(payments[_id].state == PaymentState.PaymentSent);

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.sender,
                _sender,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(_secret)))),
                _tokenAddress,
                _amount
            )
        );

        require(paymentHash == payments[_id].paymentHash);
        payments[_id].state = PaymentState.ReceiverSpent;
        if (_tokenAddress == address(0)) {
            payable(msg.sender).transfer(_amount);
        } else {
            IERC20 token = IERC20(_tokenAddress);
            require(token.transfer(msg.sender, _amount));
        }

        emit ReceiverSpent(_id, _secret);
    }

    function receiverSpendErc721(
        bytes32 _id,
        bytes32 _secret,
        address _tokenAddress,
        uint256 _tokenId,
        address _sender
    ) external {
        require(payments[_id].state == PaymentState.PaymentSent);

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.sender,
                _sender,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(_secret)))),
                _tokenAddress,
                _tokenId
            )
        );

        require(paymentHash == payments[_id].paymentHash);
        payments[_id].state = PaymentState.ReceiverSpent;

        IERC721 token = IERC721(_tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, _tokenId);

        emit ReceiverSpent(_id, _secret);
    }

    function receiverSpendErc1155(
        bytes32 _id,
        uint256 _amount,
        bytes32 _secret,
        address _tokenAddress,
        uint256 _tokenId,
        address _sender
    ) external {
        require(payments[_id].state == PaymentState.PaymentSent);

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.sender,
                _sender,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(_secret)))),
                _tokenAddress,
                _tokenId,
                _amount
            )
        );

        require(paymentHash == payments[_id].paymentHash);
        payments[_id].state = PaymentState.ReceiverSpent;

        IERC1155 token = IERC1155(_tokenAddress);
        token.safeTransferFrom(
            address(this),
            msg.sender,
            _tokenId,
            _amount,
            ""
        );

        emit ReceiverSpent(_id, _secret);
    }

    function senderRefund(
        bytes32 _id,
        uint256 _amount,
        bytes20 _paymentHash,
        address _tokenAddress,
        address _receiver
    ) external {
        require(payments[_id].state == PaymentState.PaymentSent);

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                _receiver,
                msg.sender,
                _paymentHash,
                _tokenAddress,
                _amount
            )
        );

        require(
            paymentHash == payments[_id].paymentHash &&
            block.timestamp >= payments[_id].lockTime
        );

        payments[_id].state = PaymentState.SenderRefunded;

        if (_tokenAddress == address(0)) {
            payable(msg.sender).transfer(_amount);
        } else {
            IERC20 token = IERC20(_tokenAddress);
            require(token.transfer(msg.sender, _amount));
        }

        emit SenderRefunded(_id);
    }

    function senderRefundErc721(
        bytes32 _id,
        bytes20 _paymentHash,
        address _tokenAddress,
        uint256 _tokenId,
        address _receiver
    ) external {
        require(payments[_id].state == PaymentState.PaymentSent);

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                _receiver,
                msg.sender,
                _paymentHash,
                _tokenAddress,
                _tokenId
            )
        );

        require(
            paymentHash == payments[_id].paymentHash &&
            block.timestamp >= payments[_id].lockTime
        );
        payments[_id].state = PaymentState.SenderRefunded;

        IERC721 token = IERC721(_tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, _tokenId);

        emit SenderRefunded(_id);
    }

    function senderRefundErc1155(
        bytes32 _id,
        uint256 _amount,
        bytes20 _paymentHash,
        address _tokenAddress,
        uint256 _tokenId,
        address _receiver
    ) external {
        require(payments[_id].state == PaymentState.PaymentSent);

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                _receiver,
                msg.sender,
                _paymentHash,
                _tokenAddress,
                _tokenId,
                _amount
            )
        );

        require(
            paymentHash == payments[_id].paymentHash &&
            block.timestamp >= payments[_id].lockTime
        );
        payments[_id].state = PaymentState.SenderRefunded;

        IERC1155 token = IERC1155(_tokenAddress);
        token.safeTransferFrom(
            address(this),
            msg.sender,
            _tokenId,
            _amount,
            ""
        );

        emit SenderRefunded(_id);
    }

    function onERC1155Received(
        address, /* operator */
        address, /* from */
        uint256, /* id */
        uint256, /* value */
        bytes calldata /* data */
    ) external pure override returns (bytes4) {
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
        // Return this magic value to confirm receipt of ERC1155 tokens
        return this.onERC1155BatchReceived.selector;
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
        address, /* operator */
        address, /* from */
        uint256, /* tokenId */
        bytes calldata /* data */
    ) external pure override returns (bytes4) {
        // Return this magic value to confirm receipt of ERC721 token
        return this.onERC721Received.selector;
    }
}
