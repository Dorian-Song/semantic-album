-- API keys and the n8n webhook secret now live in .env; the database no longer keeps a copy.
UPDATE model_config SET deepseek_api_key = NULL, openai_api_key = NULL, n8n_webhook_secret = NULL;
