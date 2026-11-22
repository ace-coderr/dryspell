import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arbitrumSepolia } from "wagmi/chains";
import { createPublicClient } from "viem";
import deployment from "../config/deployment.json";

export const chain = arbitrumSepolia;
export const RPC = "https://sepolia-rollup.arbitrum.io/rpc";

export const wagmiConfig = createConfig({
  chains: [arbitrumSepolia],
  connectors: [injected()],
  transports: { [arbitrumSepolia.id]: http(RPC) },
});

export const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(RPC) });

export const addr = {
  token: deployment.contracts.TestUSD as `0x${string}`,
  engine: deployment.contracts.DryspellEngine as `0x${string}`,
  vault: deployment.contracts.UnderwriterVault as `0x${string}`,
  oracle: deployment.contracts.WeatherOracle as `0x${string}`,
  book: deployment.contracts.PolicyBook as `0x${string}`,
  owner: deployment.owner as `0x${string}`,
};

export const START_BLOCK = BigInt(deployment.startBlock);
export const EXPLORER = deployment.explorer;
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;
export { deployment };
