/** Read existing account services; credentials never cross native IPC or enter saved state. */
export async function readBalance(ctx, route) {
  const get = key => typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key];
  try {
    // A provider name alone cannot prove an API endpoint or its credential scope.
    // Let the existing authenticated account service own its destination and grant.
    if(route?.provider!=='deepseek-account') return {available:false,
      reason:'当前默认模型未提供账户余额接口；实际 token 用量仍可统计'};
    const account = get('deepseekAccount');
    if (!account?.getBalance) return { available: false, reason: '当前模型服务没有可用的余额接口' };
    const result = await account.getBalance({ version: '0.2.1-rc.5', locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 });
    if (result?.status !== 'ready') return { available: false, source: 'DeepSeek 账户', reason: '账户未登录或余额暂不可用' };
    const wallets = Array.isArray(result.value) ? result.value.filter(item => ['CNY','USD'].includes(item?.currency)
      && typeof item.balance === 'string' && Number.isFinite(Number(item.balance)))
      .map(item => ({ currency: item.currency, balance: item.balance })) : [];
    const bonusWallets = Array.isArray(result.bonusWallets) ? result.bonusWallets.filter(item => ['CNY','USD'].includes(item?.currency)
      && typeof item.balance === 'string' && Number.isFinite(Number(item.balance)))
      .map(item => ({ currency: item.currency, balance: item.balance })) : [];
    return wallets.length || bonusWallets.length ? { available: true, source: 'DeepSeek 账户', wallets, bonusWallets }
      : { available: false, source: 'DeepSeek 账户', reason: '账户未返回钱包数据' };
  } catch {
    return { available: false, reason: '余额查询暂不可用；不会将查询失败显示为零余额' };
  }
}
