# Настройка API для Dev Analytics

## QuickNode RPC (уже настроен)
```
NEXT_PUBLIC_QUICKNODE_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/QN_4ae4c43cd2e143048868d499f5f77b98
```

## Solscan API (добавить)
Добавьте в файл `.env.local` следующую строку:

```
SOLSCAN_API_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjcmVhdGVkQXQiOjE3Nzk0NDk2Njk4NjgsImVtYWlsIjoicG90YXBvdmRpbWEzNTRAZ21haWwuY29tIiwiYWN0aW9uIjoidG9rZW4tYXBpIiwiYXBpVmVyc2lvbiI6InYyIiwiaWF0IjoxNzc5NDQ5NjY5fQ.N8dYxEQfrBcKKhQP3GdOFFof3DpfA9yLiFlEChj9Id4
```

## После настройки
Перезапустите dev сервер:

```bash
npm run dev
```

## Что дают эти API:
- **QuickNode RPC**: Надежный доступ к Solana mainnet
- **Solscan API**: Точный поиск creator адресов и детальная информация о токенах
- **Улучшенная аналитика**: Полные данные о всех токенах dev wallet

## Готово к тестированию
После добавления токенов откройте любой токен → вкладка "Dev Forensics" для полной аналитики creator.
