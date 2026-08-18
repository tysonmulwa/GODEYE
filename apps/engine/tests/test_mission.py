"""The shared agent charter, mission, guardrails, and per-skill roles."""

from godeye_engine.ai import content_agent, image_agent, mission, seo_agent, video_agent


class TestCharter:
    def test_includes_mission_and_principles(self):
        text = mission.charter("content")
        assert "AI Marketing Operating System" in text
        assert "Truth over invention" in text
        assert "No fake metrics" in text

    def test_includes_the_skill_role(self):
        text = mission.charter("seo")
        assert "Web Audit & SEO Agent" in text
        assert "crawled site" in text

    def test_unknown_skill_still_has_guardrails(self):
        text = mission.charter("does-not-exist")
        assert "Truth over invention" in text
        assert "Your role," not in text  # no role block, but still safe

    def test_user_requested_skills_exist(self):
        for key in ["marketing", "content", "business", "seo"]:
            assert key in mission.SKILLS
            assert mission.SKILLS[key].title


class TestAgentsAdoptCharter:
    """Every integrated agent must carry the anti-fabrication guardrails."""

    def test_all_agents_carry_the_guardrails(self):
        for prompt in (
            content_agent.SYSTEM_PROMPT,
            seo_agent.SYSTEM_PROMPT,
            video_agent.SYSTEM_PROMPT,
            image_agent.PROMPT_SYSTEM,
        ):
            assert "Truth over invention" in prompt
            assert "Never fabricate" in prompt

    def test_agents_keep_their_specialism(self):
        assert "valid JSON" in content_agent.SYSTEM_PROMPT
        assert "schema.org" in seo_agent.SYSTEM_PROMPT
        assert "TikTok" in video_agent.SYSTEM_PROMPT
        # "photograph" rather than "image prompt": the agent's specialism is
        # photography, and the old phrase was incidental wording that happened
        # to be there.
        assert "photograph" in image_agent.PROMPT_SYSTEM
