require("@nomicfoundation/hardhat-ethers");

module.exports = {
  solidity: "0.8.20",
  networks: {
    hardhat: {
      // Hardhat Network's default settings are fine for most projects
    },
    development: {
      url: "http://rpc:8545",
      chainId: 1337  // For Hardhat Network, the default chain ID is 1337
    }
  }
};
