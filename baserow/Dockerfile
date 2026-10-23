# Baserow plus a DeepSeek AI provider (see patch_deepseek.py).
ARG BASEROW_VERSION=2.4.0
FROM baserow/baserow:${BASEROW_VERSION}
COPY patch_deepseek.py /tmp/patch_deepseek.py
RUN /baserow/venv/bin/python /tmp/patch_deepseek.py && rm /tmp/patch_deepseek.py
