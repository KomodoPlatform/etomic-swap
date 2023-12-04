// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

contract Erc1155Token is ERC1155 {
    constructor(string memory uri) ERC1155(uri) {
        uint256 tokenId = 1;
        uint256 amount = 3;
        _mint(msg.sender, tokenId, amount, "");
    }
}
