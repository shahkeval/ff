#!/usr/bin/env python3
"""
Bridge script for calling a Microsoft Foundry agent from the Node backend.

Node (extract.js) owns all orchestration — batching files to fit a size
limit, building the prompt per batch, parsing the JSON answer out of the
reply, and merging results into the rest of the pipeline. This script's only
job is the actual network call, using the exact client/auth pattern from the
sample provided:

    from azure.identity import DefaultAzureCredential
    from azure.ai.projects import AIProjectClient
    project_client = AIProjectClient(endpoint=endpoint, credential=DefaultAzureCredential())
    openai_client = project_client.get_openai_client()
    response = openai_client.responses.create(
        input=[...], extra_body={"agent_reference": {"name": ..., "version": ..., "type": "agent_reference"}},
    )

Extended, beyond that minimal sample, in two ways the multi-file/multi-batch
flow needs:
  1. File attachments — uploaded via openai_client.files.create(...) (the
     client is OpenAI-SDK-shaped, so this follows the standard OpenAI Files +
     Responses `input_file` content-part convention) and referenced in the
     input message alongside the text prompt.
  2. Conversation continuity across batches — via `previous_response_id`,
     the standard Responses API parameter for continuing a prior turn. Node
     passes back the previous call's response id for every batch after the
     first.

Protocol: reads one JSON object from stdin, writes one JSON object to
stdout — {"responseId": ..., "text": ...} on success, {"error": "..."} on
failure. Never prints anything else to stdout (logging, if needed, must go
to stderr) so Node's JSON.parse of stdout stays reliable.
"""
import sys
import json


class _StaticKeyCredential:
    """Satisfies azure-ai-projects' TokenCredential-typed constructor param
    without ever needing a real Azure AD token — get_openai_client(api_key=...)
    below overrides the client's auth entirely, so this is never actually
    called; it only exists to let AIProjectClient construct successfully."""

    def get_token(self, *scopes, **kwargs):
        raise RuntimeError(
            "AAD token was requested, but this process is configured for API-key auth (FOUNDRY_API_KEY) — "
            "something tried to use Azure AD auth instead of the key override. This should not happen."
        )


def main():
    payload = json.loads(sys.stdin.read())
    endpoint = payload["endpoint"]
    agent_name = payload["agentName"]
    agent_version = payload["agentVersion"]
    prompt = payload["prompt"]
    file_paths = payload.get("filePaths", [])
    previous_response_id = payload.get("previousResponseId")
    api_key = payload.get("apiKey")  # from the Foundry resource's Keys page — simplest auth path

    from azure.ai.projects import AIProjectClient

    if api_key:
        project_client = AIProjectClient(endpoint=endpoint, credential=_StaticKeyCredential())
        openai_client = project_client.get_openai_client(api_key=api_key)
    else:
        # Fall back to Azure AD (service principal via AZURE_CLIENT_ID/SECRET,
        # or an interactive `az login` session) when no key is configured.
        from azure.identity import DefaultAzureCredential
        project_client = AIProjectClient(endpoint=endpoint, credential=DefaultAzureCredential())
        openai_client = project_client.get_openai_client()

    file_ids = []
    for path in file_paths:
        with open(path, "rb") as fh:
            uploaded = openai_client.files.create(file=fh, purpose="assistants")
            file_ids.append(uploaded.id)

    content = [{"type": "input_text", "text": prompt}]
    for fid in file_ids:
        content.append({"type": "input_file", "file_id": fid})

    kwargs = {
        "input": [{"role": "user", "content": content}],
        "extra_body": {"agent_reference": {"name": agent_name, "version": agent_version, "type": "agent_reference"}},
    }
    if previous_response_id:
        kwargs["previous_response_id"] = previous_response_id

    response = openai_client.responses.create(**kwargs)

    for fid in file_ids:
        try:
            openai_client.files.delete(fid)
        except Exception:
            pass  # best-effort cleanup, never fail the call over it

    print(json.dumps({"responseId": response.id, "text": response.output_text}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(0)  # exit 0 even on error — Node distinguishes via the JSON shape, not exit code
