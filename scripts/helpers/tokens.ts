//import { ethers } from 'hardhat';
import { Contract, ContractFactory } from 'ethers';
import { Dictionary } from 'lodash';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { deploy } from './deploy';

export type TokenList = Dictionary<Contract>;

// Deploys a vanilla ERC20 token that can be minted by any account
export async function deployTokenFromFactory(
  ethers: any,
  admin: string,
  symbol: string,
  decimals?: number
): Promise<string> {
  // Get deployed Token Factory
  const tokenFactory = await ethers.getContract('TokenFactory');

  const tx = await tokenFactory.create(admin, symbol, symbol, decimals ?? 18);
  const receipt = await tx.wait();
  const event = receipt.events?.find((e: any) => e.event == 'TokenCreated');
  if (event == undefined) {
    throw new Error('Could not find TokenCreated event');
  }

  return event.args.token;
}

export async function deployToken(
  ethers: any,
  symbol: string,
  decimals?: number,
  from?: SignerWithAddress
): Promise<string> {
  const [, defaultDeployer] = await ethers.getSigners();
  const deployer = from || defaultDeployer;
  const testToken = await deploy('TestToken', { from: deployer, args: [deployer.address, symbol, symbol, decimals] });
  return testToken.address;
}

// Deploys multiple tokens and returns a symbol -> token dictionary
export async function deployTokensFromFactory(
  ethers: any,
  Token: ContractFactory,
  tokenFactory: Contract,
  symbols: Array<string>,
  decimals: Array<number>,
  from?: SignerWithAddress
): Promise<TokenList> {
  const tokenSymbols: TokenList = {};
  const totalTokens = await tokenFactory.getTotalTokens();
  for (let i = 0; i < symbols.length; i++) {
    if (symbols[i] === 'WETH') {
      const weth = await ethers.getContract('WETH9');
      tokenSymbols[symbols[i]] = weth;
      continue;
    }
    const addr = await deployToken(ethers, symbols[i], decimals[i], from);
    const tokenContract = await Token.attach(addr);
    tokenSymbols[symbols[i]] = tokenContract;
  }
  return tokenSymbols;
}

// Deploys multiple tokens and returns a symbol -> token dictionary
export async function deployTokens(
  ethers: any,
  Token: ContractFactory,
  symbols: Array<string>,
  decimals: Array<number>,
  from?: SignerWithAddress
): Promise<TokenList> {
  const tokenSymbols: TokenList = {};
  // For each token deploy if not already deployed
  for (let i = 0; i < symbols.length; i++) {
    if (symbols[i] === 'WETH') {
      const weth = await deploy('WETH9', { from, args: [from] });
      tokenSymbols[symbols[i]] = weth;
      continue;
    }
    const addr = await deployToken(ethers, symbols[i], decimals[i], from);

    // Get token contract
    const tokenContract = await Token.attach(addr);
    tokenSymbols[symbols[i]] = tokenContract;
  }
  return tokenSymbols;
}

export async function mintTokens(
  tokens: TokenList,
  symbol: string,
  recipient: SignerWithAddress | string,
  amount: number | string,
  minter?: SignerWithAddress
): Promise<void> {
  const token = minter ? tokens[symbol].connect(minter) : tokens[symbol];
  await token.mint(typeof recipient == 'string' ? recipient : recipient.address, amount.toString());
}
