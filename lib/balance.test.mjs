import test from 'node:test';
import assert from 'node:assert/strict';
import { readBalance } from './balance.mjs';
test('account balance contains no credentials or unrelated account fields', async () => {
  const ctx = {deepseekAccount:{getBalance:async()=>({status:'ready',value:[{currency:'CNY',balance:'2.3',token:'secret'}],bonusWallets:[]})}};
  const result=await readBalance(ctx,{provider:'deepseek-account'});
  assert.equal(result.available,true); assert.equal(JSON.stringify(result).includes('secret'),false);
});
test('unrelated providers never read credentials or query another account', async () => {
  const ctx={get(){throw new Error('must not query unrelated services');}};
  const result=await readBalance(ctx,{provider:'deepseek-official'});
  assert.equal(result.available,false);
});
test('unavailable balance does not invent a zero', async()=>{
  const result=await readBalance({},{}); assert.equal(result.available,false); assert.equal('wallets' in result,false);
});
