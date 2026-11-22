#!/bin/bash
# Waits for the dispute window of the Garissa 2025 Replay round, then finalises it and settles policy 2.
# Reads the testnet key from the gitignored .env; prints transaction hashes only.
cd "$(dirname "$0")/../../.." || exit 1
set -a; source .env; set +a
R=$ARBITRUM_SEPOLIA_RPC
O=0x63210b3CBdf8B98BA38d32596622d3E95009863E
B=0x757Ea1E42F6b5fCbE0239cB29F36E7BA78FEb699
RID=2033641
ENDS=$(cast call $O 'challengeEndsAt(uint256)(uint256)' $RID --rpc-url $R | awk '{print $1}')
while [ "$(date +%s)" -le "$ENDS" ]; do sleep 20; done
sleep 15 # let the chain timestamp pass the window
send(){ cast send "$@" --rpc-url $R --private-key "$DEPLOYER_PRIVATE_KEY" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("tx",j.transactionHash,"status",j.status,"gas",parseInt(j.gasUsed,16))})'; }
echo "finalize"; send $O 'finalize(uint256)' $RID
echo "settle policy 2"; send $B 'settle(uint256)' 2
echo "policy 2: $(cast call $B 'getPolicy(uint256)((address,uint16,uint8,uint32,uint64,uint64,uint128,uint128))' 2 --rpc-url $R)"
