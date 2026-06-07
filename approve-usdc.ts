import 'dotenv/config';
import { Wallet, Contract, JsonRpcProvider } from 'ethers';

// Polygon RPC
const RPC = 'https://polygon-rpc.com';

// USDC on Polygon (native USDC)
const USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
// USDC.e (bridged) fallback
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Polymarket CTF Exchange contracts (from getBalanceAllowance response)
const SPENDERS = [
  '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  '0xE111180000d2663C0091e4f400237545B87B996B',
  '0xe2222d279d744050d28e00520010520000310F59',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

const MAX_UINT = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

async function main() {
  const provider = new JsonRpcProvider(RPC);
  const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY!, provider);
  console.log('Wallet:', wallet.address);

  // Check both USDC variants
  for (const [name, addr] of [['USDC', USDC_ADDRESS], ['USDC.e', USDC_E_ADDRESS]]) {
    const token = new Contract(addr, ERC20_ABI, wallet);
    const bal = await token.balanceOf(wallet.address);
    const decimals = await token.decimals();
    const balHuman = Number(bal) / 10 ** Number(decimals);
    console.log(`\n${name} (${addr})`);
    console.log(`  Balance: $${balHuman.toFixed(4)}`);

    if (balHuman > 0) {
      console.log(`  Approving spenders...`);
      for (const spender of SPENDERS) {
        const allowance = await token.allowance(wallet.address, spender);
        if (Number(allowance) === 0) {
          console.log(`  Approving ${spender}...`);
          const tx = await token.approve(spender, MAX_UINT);
          console.log(`  TX: ${tx.hash}`);
          await tx.wait();
          console.log(`  ✅ Approved`);
        } else {
          console.log(`  ✅ Already approved for ${spender}`);
        }
      }
    }
  }
  console.log('\nDone. Restart the bot now.');
}

main().catch(console.error);
