# -*- coding: utf-8 -*-
"""Test di integrazione e sicurezza offline per Kilo Code su runtime Hexagon."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

LEGACY_DIR = Path(__file__).resolve().parent.parent
if str(LEGACY_DIR) not in sys.path:
    sys.path.insert(0, str(LEGACY_DIR))

import kilo_config


class TestGlobalProviderInstall(unittest.TestCase):
    """Test per install_global_provider (provider hexagon nel config globale Kilo)."""

    def setUp(self):
        self.workspace_dir = Path(__file__).resolve().parent.parent.parent
        self.tmp = tempfile.TemporaryDirectory()
        self.config_dir = Path(self.tmp.name) / "kilo"

    def tearDown(self):
        self.tmp.cleanup()

    def test_install_creates_global_config(self):
        path, changed, issues = kilo_config.install_global_provider(self.workspace_dir, self.config_dir)
        self.assertEqual(issues, [])
        self.assertTrue(changed)
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertIn("hexagon", data["provider"])
        self.assertEqual(data["provider"]["hexagon"]["npm"], "@ai-sdk/openai-compatible")
        self.assertTrue(data["provider"]["hexagon"]["options"]["baseURL"].startswith("http://127.0.0.1"))

    def test_install_preserves_existing_entries_and_backs_up(self):
        self.config_dir.mkdir(parents=True)
        existing = {
            "permission": {"bash": {"git status *": "allow"}},
            "provider": {"other": {"npm": "some-package"}},
        }
        path = self.config_dir / kilo_config.GLOBAL_CONFIG_NAME
        path.write_text(json.dumps(existing), encoding="utf-8")

        result_path, changed, issues = kilo_config.install_global_provider(self.workspace_dir, self.config_dir)

        self.assertEqual(issues, [])
        self.assertTrue(changed)
        data = json.loads(result_path.read_text(encoding="utf-8"))
        self.assertEqual(data["permission"], existing["permission"])
        self.assertIn("other", data["provider"])
        self.assertIn("hexagon", data["provider"])
        backups = list(self.config_dir.glob(f"{kilo_config.GLOBAL_CONFIG_NAME}.bak-*"))
        self.assertEqual(len(backups), 1)

    def test_install_is_idempotent(self):
        kilo_config.install_global_provider(self.workspace_dir, self.config_dir)
        _, changed, issues = kilo_config.install_global_provider(self.workspace_dir, self.config_dir)
        self.assertFalse(changed)
        self.assertEqual(issues, [])
        self.assertEqual(len(list(self.config_dir.glob(f"{kilo_config.GLOBAL_CONFIG_NAME}.bak-*"))), 0)

    def test_install_refuses_unparsable_config(self):
        self.config_dir.mkdir(parents=True)
        path = self.config_dir / kilo_config.GLOBAL_CONFIG_NAME
        path.write_text("{ non e json", encoding="utf-8")

        _, changed, issues = kilo_config.install_global_provider(self.workspace_dir, self.config_dir)

        self.assertFalse(changed)
        self.assertTrue(issues)
        self.assertEqual(path.read_text(encoding="utf-8"), "{ non e json")


class TestKiloConfig(unittest.TestCase):
    """Test unitari per la generazione e validazione di kilo.json."""

    def setUp(self):
        self.workspace_dir = Path(__file__).resolve().parent.parent.parent
        self.ini_path = self.workspace_dir / "hexagon-models.ini"

    def test_parse_hexagon_models_ini(self):
        """Verifica parsing corretto dei preset hardware da hexagon-models.ini."""
        if not self.ini_path.is_file():
            self.skipTest(f"File {self.ini_path} non presente.")

        models = kilo_config.parse_hexagon_models_ini(self.ini_path)
        self.assertIsInstance(models, dict)
        self.assertGreaterEqual(len(models), 10)

        # Verifica presenza di modelli chiave
        self.assertIn("Ornith-1.5-9B-Q4_0", models)
        self.assertIn("MiniCPM5-2B-Q4_K_M", models)

        # Verifica metadati
        ornith = models["Ornith-1.5-9B-Q4_0"]
        self.assertIn("ctx_size", ornith)
        self.assertIn("device", ornith)
        self.assertEqual(ornith["device"], "HTP0")
        self.assertGreaterEqual(ornith["ctx_size"], 4096)

    def test_parse_hexagon_models_ini_missing(self):
        """Verifica gestione corretta di file INI inesistente."""
        fake_path = Path("non_existent_models.ini")
        models = kilo_config.parse_hexagon_models_ini(fake_path)
        self.assertEqual(models, {})

    def test_generate_kilo_config_structure(self):
        """Verifica la struttura del dizionario kilo.json generato.

        Il test e' ermetico: usa un INI di fixture in directory temporanea e
        disattiva la consultazione HTTP del router, per non dipendere da
        hexagon-models.ini (gitignored, assente in CI) ne' da un router attivo.
        """
        fixture_ini = """[*]
flash-attn = on
[Ornith-1.5-9B-Q4_0]
model = /models/ornith.gguf
device = HTP0
ctx-size = 8192
[MiniCPM5-2B-Q4_K_M]
model = /models/minicpm.gguf
device = HTP0
ctx-size = 4096
"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_workspace = Path(tmp_dir)
            (tmp_workspace / "hexagon-models.ini").write_text(fixture_ini, encoding="utf-8")
            with patch("kilo_config.fetch_live_models", return_value=[]):
                cfg = kilo_config.generate_kilo_config(tmp_workspace)

        # Struttura base
        self.assertIn("provider", cfg)
        self.assertIn("hexagon", cfg["provider"])
        hexagon = cfg["provider"]["hexagon"]

        # Parametri provider
        self.assertEqual(hexagon["npm"], "@ai-sdk/openai-compatible")
        self.assertTrue(hexagon["options"]["baseURL"].startswith("http://127.0.0.1:"))
        self.assertIn("models", hexagon)
        self.assertGreater(len(hexagon["models"]), 0)

        # Modelli principali
        self.assertEqual(cfg["model"], "hexagon/Ornith-1.5-9B-Q4_0")
        self.assertEqual(cfg["small_model"], "hexagon/MiniCPM5-2B-Q4_K_M")

        # Limiti contesto e output
        ornith_model = hexagon["models"]["Ornith-1.5-9B-Q4_0"]
        self.assertIn("limit", ornith_model)
        self.assertIn("context", ornith_model["limit"])
        self.assertIn("output", ornith_model["limit"])
        self.assertLessEqual(ornith_model["limit"]["output"], ornith_model["limit"]["context"])

        # Permessi di sicurezza
        perms = cfg["permission"]
        self.assertEqual(perms.get("read", {}).get("*"), "allow")
        self.assertEqual(perms.get("edit", {}).get("*"), "ask")
        self.assertEqual(perms.get("write", {}).get("*"), "ask")
        self.assertEqual(perms.get("bash", {}).get("*"), "ask")
        self.assertEqual(perms.get("task"), "ask")

    def test_fetch_live_models_mocked(self):
        """Verifica parsing della risposta /v1/models con mock httpx."""
        with patch("httpx.get") as mock_get:
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {
                "data": [
                    {"id": "Ornith-1.5-9B-Q4_0"},
                    {"id": "MiniCPM5-2B-Q4_K_M"}
                ]
            }
            mock_get.return_value = mock_resp

            models = kilo_config.fetch_live_models("http://127.0.0.1:18803/v1")
            self.assertEqual(models, ["Ornith-1.5-9B-Q4_0", "MiniCPM5-2B-Q4_K_M"])

    def test_fetch_live_models_offline_fallback(self):
        """Verifica gestione corretta in caso di server non raggiungibile."""
        with patch("httpx.get", side_effect=OSError("Connection refused")):
            models = kilo_config.fetch_live_models("http://127.0.0.1:18803/v1")
            self.assertEqual(models, [])

    def test_validate_kilo_config_valid(self):
        """Verifica che la configurazione predefinita passi tutti i controlli di validazione."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            cfg = kilo_config.generate_kilo_config(self.workspace_dir)
            cfg_file = kilo_config.write_kilo_config(tmp_path, cfg)

            ok, issues = kilo_config.validate_kilo_config(cfg_file)
            self.assertTrue(ok, f"Configurazione non valida: {issues}")
            self.assertEqual(issues, [])

    def test_validate_kilo_config_security_violations(self):
        """Verifica che tentativi di configurazione insicura o cloud siano rilevati."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            bad_cfg_file = tmp_path / "kilo.json"

            # 1. BaseURL esterna
            bad_cfg = kilo_config.generate_kilo_config(self.workspace_dir)
            bad_cfg["provider"]["hexagon"]["options"]["baseURL"] = "https://api.openai.com/v1"
            with open(bad_cfg_file, "w", encoding="utf-8") as f:
                json.dump(bad_cfg, f)
            ok, issues = kilo_config.validate_kilo_config(bad_cfg_file)
            self.assertFalse(ok)
            self.assertTrue(any("loopback" in iss for iss in issues))

            # 2. Modello esterno / cloud fallback
            bad_cfg = kilo_config.generate_kilo_config(self.workspace_dir)
            bad_cfg["model"] = "anthropic/claude-3-5-sonnet"
            with open(bad_cfg_file, "w", encoding="utf-8") as f:
                json.dump(bad_cfg, f)
            ok, issues = kilo_config.validate_kilo_config(bad_cfg_file)
            self.assertFalse(ok)
            self.assertTrue(any("model non punta al provider locale" in iss for iss in issues))

            # 3. Permessi globali permissivi (bash allow)
            bad_cfg = kilo_config.generate_kilo_config(self.workspace_dir)
            bad_cfg["permission"]["bash"] = "allow"
            with open(bad_cfg_file, "w", encoding="utf-8") as f:
                json.dump(bad_cfg, f)
            ok, issues = kilo_config.validate_kilo_config(bad_cfg_file)
            self.assertFalse(ok)
            self.assertTrue(any("Permesso bash" in iss for iss in issues))

            # 4. Schema non valido: chiave plurale 'permissions' e wildcard edit allow
            bad_cfg = kilo_config.generate_kilo_config(self.workspace_dir)
            bad_cfg["permissions"] = {"edit": "ask"}
            bad_cfg["permission"]["edit"] = {"*": "allow"}
            bad_cfg["plugin"] = "not-a-list"
            with open(bad_cfg_file, "w", encoding="utf-8") as f:
                json.dump(bad_cfg, f)
            ok, issues = kilo_config.validate_kilo_config(bad_cfg_file)
            self.assertFalse(ok)
            self.assertTrue(any("permissions" in iss for iss in issues))
            self.assertTrue(any("Permesso edit" in iss for iss in issues))
            self.assertTrue(any("plugin" in iss for iss in issues))

            # 5. Schema non valido: azione permission non ammessa e $schema invalido
            bad_cfg = kilo_config.generate_kilo_config(self.workspace_dir)
            bad_cfg["$schema"] = "http://insecure.example/schema.json"
            bad_cfg["permission"]["task"] = "permit"
            with open(bad_cfg_file, "w", encoding="utf-8") as f:
                json.dump(bad_cfg, f)
            ok, issues = kilo_config.validate_kilo_config(bad_cfg_file)
            self.assertFalse(ok)
            self.assertTrue(any("$schema" in iss for iss in issues))
            self.assertTrue(any("permit" in iss for iss in issues))

    def test_validate_kilo_config_workspace_validates_agents_schema(self):
        """Verifica che validate_kilo_config sul repo controlli anche .kilo/agents/*.md."""
        repo_cfg = self.workspace_dir / "kilo.json"
        ok, issues = kilo_config.validate_kilo_config(repo_cfg)
        self.assertTrue(ok, f"kilo.json e .kilo/agents non validi: {issues}")

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            cfg = kilo_config.generate_kilo_config(self.workspace_dir)
            cfg_file = kilo_config.write_kilo_config(tmp_path, cfg)
            agents_dir = tmp_path / ".kilo" / "agents"
            agents_dir.mkdir(parents=True)
            (agents_dir / "broken.md").write_text(
                "---\nname: broken\ndescription: Broken agent\nmode: primary\npermissions:\n  read: allow\n---\nPrompt\n",
                encoding="utf-8",
            )
            ok, issues = kilo_config.validate_kilo_config(cfg_file)
            self.assertFalse(ok)
            self.assertTrue(any("permissions" in iss for iss in issues))


class TestKiloAgents(unittest.TestCase):
    """Test di validazione dei ruoli e permessi per gli agenti in .kilo/agents/."""

    def setUp(self):
        self.workspace_dir = Path(__file__).resolve().parent.parent.parent
        self.agents_dir = self.workspace_dir / ".kilo" / "agents"

    def test_agents_directory_and_files_exist(self):
        """Verifica la presenza di tutti i ruoli agentici definiti."""
        self.assertTrue(self.agents_dir.is_dir(), ".kilo/agents/ directory mancante.")
        expected_agents = ["ask.md", "code.md", "plan.md", "debug.md", "explore.md", "reviewer.md"]
        for agent_file in expected_agents:
            agent_path = self.agents_dir / agent_file
            self.assertTrue(agent_path.is_file(), f"File agente mancante: {agent_file}")

    def test_agents_schema_uses_singular_permission(self):
        """Verifica che tutti gli agenti usino 'permission:' (mai 'permissions:') e superino lo schema."""
        ok, issues = kilo_config.validate_kilo_agents(self.agents_dir)
        self.assertTrue(ok, f"Schema agenti non valido: {issues}")
        for md_path in sorted(self.agents_dir.glob("*.md")):
            content = md_path.read_text(encoding="utf-8")
            self.assertIn("\npermission:\n", content, f"{md_path.name} deve usare 'permission:'")
            self.assertNotIn("\npermissions:\n", content, f"{md_path.name} non deve usare 'permissions:'")

    def test_subagents_security_boundary(self):
        """Verifica che i subagenti di esplorazione e revisione abbiano edit e bash negati."""
        subagents = ["explore.md", "reviewer.md"]
        for sa in subagents:
            content = (self.agents_dir / sa).read_text(encoding="utf-8")
            self.assertIn("mode: subagent", content, f"{sa} deve avere mode: subagent")
            self.assertIn("edit: deny", content, f"{sa} deve avere edit: deny")
            self.assertIn("write: deny", content, f"{sa} deve avere write: deny")
            self.assertIn("bash: deny", content, f"{sa} deve avere bash: deny")

    def test_primary_agents_mode(self):
        """Verifica che ask, code, plan e debug abbiano modalità primary."""
        primary = ["ask.md", "code.md", "plan.md", "debug.md"]
        for ag in primary:
            content = (self.agents_dir / ag).read_text(encoding="utf-8")
            self.assertIn("mode: primary", content, f"{ag} deve avere mode: primary")


if __name__ == "__main__":
    unittest.main()
