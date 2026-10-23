"""Add a DeepSeek AI provider to the Baserow image (backend + both frontend bundles).

DeepSeek reuses Baserow's OpenAI adapter (Responses API) with its own base URL default
and a suggested model list. Every edit asserts its anchor so a Baserow upgrade that
moves the code fails the image build instead of silently skipping the patch.
"""

import re
from pathlib import Path

ROOT = Path("/baserow")
BACKEND = ROOT / "backend/src/baserow"
FRONTEND = ROOT / "web-frontend/.output"
DEFAULT_BASE_URL = "https://api.deepseek.com"
KNOWN_MODELS = ["deepseek-flash"]


def edit(path: Path, anchor: str, replacement: str) -> None:
    text = path.read_text()
    assert text.count(anchor) == 1, f"anchor not unique in {path}: {anchor[:60]!r}"
    path.write_text(text.replace(anchor, replacement))


# --- backend -------------------------------------------------------------------

edit(
    BACKEND / "core/ai_provider/constants.py",
    '    "openrouter": {\n        "name": "OpenRouter",',
    '    "deepseek": {\n'
    '        "name": "DeepSeek",\n'
    '        "uses_api_key": True,\n'
    '        "extra_settings": ("base_url",),\n'
    "    },\n"
    '    "openrouter": {\n        "name": "OpenRouter",',
)

serializers = BACKEND / "api/generative_ai/serializers.py"
serializers.write_text(
    serializers.read_text()
    + f'''

class DeepSeekSettingsSerializer(GenerativeAIModelsSerializer):
    api_key = serializers.CharField(
        allow_blank=True,
        required=False,
        help_text="The DeepSeek API key.",
    )
    base_url = serializers.URLField(
        allow_blank=True,
        required=False,
        help_text="{DEFAULT_BASE_URL} by default.",
    )
'''
)

model_types = BACKEND / "core/generative_ai/generative_ai_model_types.py"
model_types.write_text(
    model_types.read_text()
    + f'''

class DeepSeekGenerativeAIModelType(BaseOpenAIGenerativeAIModelType):
    """DeepSeek through the OpenAI Responses adapter, with its own base URL."""

    type = "deepseek"
    supports_legacy_workspace_settings = False

    @cached_property
    def file_handler(self) -> EmbedOnlyFileHandler:
        return EmbedOnlyFileHandler()

    def get_api_key(
        self,
        workspace: Optional[Workspace] = None,
        settings_override: Optional[dict[str, Any]] = None,
        state: Optional[ScopedAIProviderState] = None,
    ) -> Optional[str]:
        configured, value = self.get_configured_setting(
            workspace, "api_key", settings_override, state=state
        )
        return value if configured else None

    def get_enabled_models(
        self,
        workspace: Optional[Workspace] = None,
        settings_override: Optional[dict[str, Any]] = None,
        feature_type: str | None = None,
        state: Optional[ScopedAIProviderState] = None,
    ) -> list[str]:
        configured, value = self.get_configured_setting(
            workspace, "models", settings_override, feature_type, state
        )
        return value if configured else []

    def get_organization(
        self,
        workspace: Optional[Workspace] = None,
        settings_override: Optional[dict[str, Any]] = None,
    ) -> Optional[str]:
        return None

    def get_base_url(
        self,
        workspace: Optional[Workspace] = None,
        settings_override: Optional[dict[str, Any]] = None,
    ) -> str:
        configured, value = self.get_configured_setting(
            workspace, "base_url", settings_override
        )
        return value if configured and value else "{DEFAULT_BASE_URL}"

    def get_known_models(self) -> list[str]:
        return {KNOWN_MODELS!r}

    def get_settings_serializer(self) -> type:
        from baserow.api.generative_ai.serializers import DeepSeekSettingsSerializer

        return DeepSeekSettingsSerializer
'''
)

apps = BACKEND / "core/apps.py"
edit(
    apps,
    "            AnthropicGenerativeAIModelType,\n            BedrockGenerativeAIModelType,",
    "            AnthropicGenerativeAIModelType,\n            BedrockGenerativeAIModelType,\n"
    "            DeepSeekGenerativeAIModelType,",
)
edit(
    apps,
    "generative_ai_model_type_registry.register(OpenRouterGenerativeAIModelType())",
    "generative_ai_model_type_registry.register(OpenRouterGenerativeAIModelType())\n"
    "        generative_ai_model_type_registry.register(DeepSeekGenerativeAIModelType())",
)

# --- frontend --------------------------------------------------------------------

# A subclass of the bundle's OpenAI type: same fields minus organization, own labels.
def deepseek_class(openai_class: str) -> str:
    return (
        f"(class extends {openai_class}{{"
        "static getType(){return`deepseek`}"
        "getName(){return`DeepSeek`}"
        "getSettings(){return super.getSettings()"
        ".filter(s=>s.key!==`organization`)"
        ".map(s=>s.key===`api_key`?{...s,label:`API Key`,description:`Enter a DeepSeek API key.`}"
        f":s.key===`base_url`?{{...s,label:`Base URL (optional)`,description:`Defaults to {DEFAULT_BASE_URL}.`}}"
        ":{...s,description:`Comma-separated DeepSeek model identifiers, for example deepseek-flash.`})}"
        "getModelIdentifierDescription(){return`Enter a DeepSeek model identifier, for example deepseek-flash.`}"
        "canPromptWithFiles(){return!1}"
        "getOrder(){return 15}})"
    )


client_files = [
    p for p in (FRONTEND / "public/_nuxt").glob("*.js")
    if "static getType(){return`openrouter`}" in p.read_text()
]
assert len(client_files) == 1, f"expected one client bundle, found {client_files}"
client = client_files[0]
text = client.read_text()
openai_var = re.search(r"([\w$]+)=class extends [\w$]+\{static getType\(\)\{return`openai`\}", text)[1]
openrouter_var = re.search(r"([\w$]+)=class extends [\w$]+\{static getType\(\)\{return`openrouter`\}", text)[1]
reg = re.search(rf"([\w$]+)\.register\(`generativeAIModel`,new {re.escape(openrouter_var)}\(([\w$]+)\)\)", text)
registry, ctx = reg[1], reg[2]
edit(
    client,
    reg[0],
    f"{reg[0]},{registry}.register(`generativeAIModel`,new {deepseek_class(openai_var)}({ctx}))",
)

edit(
    FRONTEND / "server/chunks/virtual/entry.mjs",
    'registry.register("generativeAIModel", new OpenRouterModelType(context));',
    'registry.register("generativeAIModel", new OpenRouterModelType(context));\n'
    f'\t\tregistry.register("generativeAIModel", new {deepseek_class("OpenAIModelType")}(context));',
)

print(f"DeepSeek provider patched (client bundle {client.name})")
