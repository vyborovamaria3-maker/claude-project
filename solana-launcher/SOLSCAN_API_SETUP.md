# Настройка API для Dev Analytics

## Solana RPC
Добавьте URL вашего RPC-провайдера в `.env.local`:

```env
NEXT_PUBLIC_QUICKNODE_RPC_URL=https://your-solana-rpc-provider.example/v2/<YOUR_RPC_KEY>
```

## Solscan API
Добавьте токен Solscan в `.env.local`:

```env
SOLSCAN_API_TOKEN=<YOUR_SOLSCAN_API_TOKEN>
```

Не коммитьте реальные API-ключи или токены в репозиторий. Для production храните их только в секретах окружения/CI.

## После настройки
Перезапустите dev сервер:

```bash
npm run dev
```

## Что дают эти API:
- **Solana RPC**: Надежный доступ к Solana mainnet
- **Solscan API**: Точный поиск creator адресов и детальная информация о токенах
- **Улучшенная аналитика**: Полные данные о всех токенах dev wallet

## Готово к тестированию
После добавления токенов откройте любой токен → вкладка "Dev Forensics" для полной аналитики creator.
