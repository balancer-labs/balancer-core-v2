import { ethers } from 'hardhat';

import { deploy } from '../../../../lib/helpers/deploy';

import Token from './Token';
import TokenList from './TokenList';
import TypesConverter from '../types/TypesConverter';
import { RawTokenDeployment, RawTokensDeployment, TokenDeployment, TokensDeploymentOptions } from './types';

class TokensDeployer {
  async deploy(params: RawTokensDeployment, { sorted, from }: TokensDeploymentOptions = {}): Promise<TokenList> {
    const defaultSender = from || (await ethers.getSigners())[0];
    const trimmedParams = sorted ? this._trimParamsForSortedDeploy(params) : params;
    const deployments: TokenDeployment[] = TypesConverter.toTokenDeployments(trimmedParams, defaultSender);
    const tokens = await Promise.all(deployments.map(this.deployToken));
    const sortedTokens = sorted ? this._sortTokensDeployment(tokens, params) : tokens;
    return new TokenList(sortedTokens);
  }

  async deployToken(params: RawTokenDeployment): Promise<Token> {
    const { symbol, name, decimals, from } = TypesConverter.toTokenDeployment(params);
    const sender = from || (await ethers.getSigners())[0];

    const instance =
      symbol === 'WETH'
        ? await deploy('WETH9', { from: sender, args: [sender.address] })
        : await deploy('TestToken', { from: sender, args: [sender.address, 'Token', 'TKN', decimals] });

    return new Token(name, symbol, decimals, instance);
  }

  private _sortTokensDeployment(tokens: Token[], params: RawTokensDeployment): Token[] {
    const sortedTokens = [...tokens].sort((a, b) => a.compare(b));
    return TypesConverter.toTokenDeployments(params).map((param, i) => {
      const token = sortedTokens[i];
      token.name = param.name;
      token.symbol = param.symbol;
      return token;
    });
  }

  private _trimParamsForSortedDeploy(params: RawTokensDeployment): number {
    if (typeof params === 'number') return params;
    return Array.isArray(params) ? params.length : 1;
  }
}

export default new TokensDeployer();
