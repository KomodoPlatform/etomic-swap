require("@nomicfoundation/hardhat-ethers");

module.exports = {
  solidity: "0.8.20",
  networks: {
    hardhat: {
      chainId: 1337, // or another number that Remix will accept
      host: "0.0.0.0", // Listen on all network interfaces
      port: 8545 // Ensure this matches the port exposed in docker-compose
    }
  }
};
