require("dotenv").config();

const TRON_PRIVATE_KEY = process.env.TRON_PRIVATE_KEY;

if (!TRON_PRIVATE_KEY) {
  console.warn(
    "Warning: Missing TRON_PRIVATE_KEY environment variable. " +
    "TronBox deploy/migrate commands will fail without it."
  );
}

module.exports = {
  contracts_directory: "./contracts_tron",

  networks: {
    // TRON Nile testnet
    nile: {
      privateKey: TRON_PRIVATE_KEY,
      fullHost: process.env.TRON_NILE_FULLHOST || "https://nile.trongrid.io",
      network_id: "*",
    },

    // TRON Mainnet
    mainnet: {
      privateKey: TRON_PRIVATE_KEY,
      fullHost: process.env.TRON_MAINNET_FULLHOST || "https://api.trongrid.io",
      network_id: "*",
    },
  },

  compilers: {
    solc: {
      version: "0.8.26",
      settings: {
        optimizer: {
          enabled: true,
          runs: 10000,
        },
      },
    },
  },
};
