-- AI descriptions send photos to a cloud provider, so they stay off until the user turns them on in Settings.
ALTER TABLE model_config ADD COLUMN captions_enabled INTEGER NOT NULL DEFAULT 0;
-- No OpenAI model is assumed; the user picks one when enabling the fallback.
UPDATE model_config SET openai_model = NULL WHERE openai_model = '';
