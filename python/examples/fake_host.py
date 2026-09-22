"""Simulate four host runs against a local monitor session file.

Run from the repository root:

    python python/examples/fake_host.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from jev_monitor import MonitorSender


def _checks(result: str, observed: str, evidence: str) -> list:
    return [{'name': '结果检查', 'observed': observed, 'result': result, 'evidence': evidence}]


def _choice(sender: MonitorSender, question: str, choice: str, other: str, high: float) -> None:
    sender.decision_started(
        'decision-1',
        'request-1',
        'question-1',
        'choice',
        question,
        candidates={choice: choice, other: other},
    )
    sender.decision_resolved(
        'decision-1',
        'request-1',
        'question-1',
        'choice',
        choice=choice,
        probabilities={choice: high, other: round(1 - high, 2)},
        confidence=0.72,
        model='fake-host',
        latency_ms=12,
        explanation='示例分布',
        explanation_source='fake-host',
    )


def play_normal(sender: MonitorSender) -> None:
    sender.run_started('模拟：正常完成', simulated=True)
    sender.progress(phase='执行', completed=0, total=1, summary='开始')
    _choice(sender, '下一步？', '继续', '停止', 0.86)
    sender.action_selected('action-1', 'attempt-1', '继续', 'model', decision_id='decision-1')
    sender.action_started('action-1', 'attempt-1', decision_id='decision-1')
    sender.action_completed('action-1', 'attempt-1', decision_id='decision-1')
    sender.verification(
        'action-1',
        'attempt-1',
        'passed',
        _checks('passed', '已继续', '输出与计划一致'),
        decision_id='decision-1',
    )
    sender.progress(phase='执行', completed=1, total=1, summary='完成')
    sender.run_completed()


def play_rule_override(sender: MonitorSender) -> None:
    sender.run_started('模拟：规则覆盖', simulated=True)
    _choice(sender, '遇到风险时？', '继续', '停止', 0.9)
    sender.action_selected(
        'action-1',
        'attempt-1',
        '停止',
        'rule',
        decision_id='decision-1',
        rule='危险时停止',
        rule_source='policy',
        reason='规则覆盖模型选择',
    )
    sender.action_started('action-1', 'attempt-1', decision_id='decision-1')
    sender.action_completed('action-1', 'attempt-1', decision_id='decision-1')
    sender.verification(
        'action-1',
        'attempt-1',
        'passed',
        _checks('passed', '已停止', '规则要求的动作已执行'),
        decision_id='decision-1',
    )
    sender.run_completed()


def play_retry(sender: MonitorSender) -> None:
    sender.run_started('模拟：失败后重试', simulated=True)
    _choice(sender, '调用工具？', '调用', '跳过', 0.8)
    sender.action_selected('action-1', 'attempt-1', '调用', 'model', decision_id='decision-1')
    sender.action_started('action-1', 'attempt-1', decision_id='decision-1')
    sender.action_failed('action-1', 'attempt-1', decision_id='decision-1', reason='timeout')
    sender.action_selected('action-1', 'attempt-2', '调用', 'model', decision_id='decision-1')
    sender.action_started('action-1', 'attempt-2', decision_id='decision-1', retry=1)
    sender.action_completed('action-1', 'attempt-2', decision_id='decision-1')
    sender.verification(
        'action-1',
        'attempt-2',
        'passed',
        _checks('passed', '第二次成功', '重试后返回结果'),
        decision_id='decision-1',
    )
    sender.run_completed()


def play_verify_failed(sender: MonitorSender) -> None:
    sender.run_started('模拟：验证失败', simulated=True)
    _choice(sender, '写入摘要？', '写入', '跳过', 0.64)
    sender.action_selected('action-1', 'attempt-1', '写入', 'model', decision_id='decision-1')
    sender.action_started('action-1', 'attempt-1', decision_id='decision-1')
    sender.action_completed('action-1', 'attempt-1', decision_id='decision-1')
    sender.verification(
        'action-1',
        'attempt-1',
        'failed',
        _checks('failed', '输出为空', '没有得到预期文本'),
        decision_id='decision-1',
        reason='验证未通过',
    )
    sender.run_failed('验证未通过')


SCENARIOS = (
    ('normal', play_normal),
    ('rule-override', play_rule_override),
    ('retry', play_retry),
    ('verify-failed', play_verify_failed),
)


def main() -> int:
    for name, play in SCENARIOS:
        with MonitorSender(host_name='fake-host') as sender:
            play(sender)
            sender.close(timeout=5)
            stats = sender.stats()
        print(f'{name}: sent={stats["sent"]} dropped={stats["dropped"]} offline={stats["offline"]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
