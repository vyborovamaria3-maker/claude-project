# Настройка QuickNode RPC для Dev Analytics

Добавьте в файл `.env.local` следующую строку:

```
NEXT_PUBLIC_QUICKNODE_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/QN_4ae4c43cd2e143048868d499f5f77b98
```

После добавления перезапустите dev сервер:

```bash
npm run dev
```

Это RPC будет использоваться для получения данных о токенах dev wallet в системе аналитики.
