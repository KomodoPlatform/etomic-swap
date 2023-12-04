// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract Erc721Token is ERC721 {
    constructor(string memory name, string memory symbol) ERC721(name, symbol) {
        uint256 tokenId = 1;
        _mint(msg.sender, tokenId);
    }
}
