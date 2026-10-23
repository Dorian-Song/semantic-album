-- Project settings: 800 description requests in flight to DeepSeek (the account allows 2,500), n8n normalisation
-- at 64, Both as the default search, AI descriptions on, and OpenAI as the fallback provider.
UPDATE model_config SET caption_concurrency = 800, enrichment_concurrency = 64, default_search_mode = 'both',
  captions_enabled = 1, openai_fallback_enabled = 1, openai_model = COALESCE(openai_model, 'gpt-6-sol');
