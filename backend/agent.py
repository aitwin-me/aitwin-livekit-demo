"""
LiveKit Agents worker — STT + LLM text only; AiTwin owns TTS/avatar on the client.

Pipeline:
  user mic / lk.chat → STT (optional) → OpenAI LLM → text
  → publish topic aitwin.speak
  → browser AiTwin.speakText()
"""

from __future__ import annotations

import asyncio
import logging
import os

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    ConversationItemAddedEvent,
    JobContext,
    WorkerOptions,
    cli,
    llm,
)
from livekit.agents.voice.room_io import RoomOptions
from livekit.plugins import openai, silero

load_dotenv()

logger = logging.getLogger("aitwin-livekit-demo")
logger.setLevel(logging.INFO)


def _require_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required env var: {name} (set it in backend/.env)")
    return value


AGENT_NAME = _require_env("AGENT_NAME")
_LLM_MODEL = _require_env("LLM_MODEL")
_STT_MODEL = _require_env("STT_MODEL")
TOPIC_SPEAK = _require_env("TOPIC_SPEAK")


class VoiceAssistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are a helpful assistant whose replies are spoken by an AiTwin avatar. "
                "Keep replies to 1-2 short sentences. Prefer fast, natural speech."
            )
        )


async def entrypoint(ctx: JobContext) -> None:
    logger.info("Connecting to room: %s", ctx.room.name)
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    session = AgentSession(
        vad=silero.VAD.load(),
        stt=openai.STT(model=_STT_MODEL),
        llm=openai.LLM(model=_LLM_MODEL),
        # AiTwin (browser) owns TTS — do not synthesize or publish agent audio.
        tts=None,
    )

    async def publish_speak(text: str) -> None:
        cleaned = (text or "").strip()
        if not cleaned or not ctx.room.isconnected():
            return
        try:
            await ctx.room.local_participant.send_text(cleaned, topic=TOPIC_SPEAK)
            logger.info("published %s (%d chars): %s", TOPIC_SPEAK, len(cleaned), cleaned[:120])
        except Exception:
            logger.warning("failed to publish %s", TOPIC_SPEAK, exc_info=True)

    @session.on("conversation_item_added")
    def _on_conversation_item(ev: ConversationItemAddedEvent) -> None:
        item = ev.item
        if not isinstance(item, llm.ChatMessage) or item.role != "assistant":
            return
        text = (item.text_content or item.raw_text_content or "").strip()
        if not text:
            return
        asyncio.create_task(publish_speak(text))

    await session.start(
        agent=VoiceAssistant(),
        room=ctx.room,
        room_options=RoomOptions(
            audio_input=True,
            text_input=True,
            audio_output=False,
            # Disable RoomIO lk.transcription — browser TTS uses aitwin.speak only.
            text_output=False,
            video_input=False,
        ),
    )

    await session.generate_reply(
        instructions="Greet the user in one short friendly sentence.",
    )


def main() -> None:
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name=AGENT_NAME,
            num_idle_processes=1,
        )
    )


if __name__ == "__main__":
    main()
