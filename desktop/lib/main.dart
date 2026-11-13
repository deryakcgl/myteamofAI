import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import 'runner.dart';

void main() => runApp(const GraphworkApp());

class GraphworkApp extends StatelessWidget {
  const GraphworkApp({super.key});

  @override
  Widget build(BuildContext context) {
    ThemeData theme(Brightness b) => ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF5B5BD6), brightness: b),
          useMaterial3: true,
        );
    return MaterialApp(
      title: 'graphwork',
      debugShowCheckedModeBanner: false,
      theme: theme(Brightness.light),
      darkTheme: theme(Brightness.dark),
      home: const HomePage(),
    );
  }
}

class Example {
  const Example(this.file, this.label, this.description);
  final String file;
  final String label;
  final String description;
}

const examples = [
  Example('team-of-teams.ts', 'Claude team', 'Claude subagents with validation loops, cross-checked by Codex and Cursor every round (5+ rounds)'),
];

const agentColors = {
  'claude': Color(0xFFD97757),
  'codex': Color(0xFF10A37F),
  'cursor': Color(0xFF3B82F6),
};

const agentLabels = {'claude': 'Claude Code', 'codex': 'Codex', 'cursor': 'Cursor'};

enum NodeStatus { waiting, running, done, failed }

class LogLine {
  LogLine(this.text, {this.kind = LogKind.info});
  final String text;
  final LogKind kind;
}

enum LogKind { info, start, done, route, raw, warn, error }

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final _projectDir = TextEditingController(text: defaultProjectDir);
  final _workFolder = TextEditingController(text: '$home/graphwork-projects/tremor-spoon');
  final _task = TextEditingController(text: 'Build a small Node.js CLI that converts a CSV file to JSON, with tests.');
  final _logScroll = ScrollController();

  Example _example = examples.last;
  bool _mock = true;
  bool _existing = true;
  GraphworkRunner? _runner;
  StreamSubscription<Map<String, dynamic>>? _sub;

  List<TeamNode> _team = [];
  String? _teamError;
  final Map<String, NodeStatus> _status = {};
  final Map<String, int> _runs = {};
  final List<LogLine> _log = [];
  Map<String, dynamic>? _result;
  String? _runError;
  ({String header, List<TodoItem> items})? _todo;
  final Map<int, TextEditingController> _answers = {};

  bool get _running => _sub != null;

  @override
  void initState() {
    super.initState();
    _loadTeam();
    _loadTodo();
  }

  String get _folder => _workFolder.text.trim();

  void _loadTodo() {
    for (final c in _answers.values) {
      c.dispose();
    }
    _answers.clear();
    _todo = _hasSavedRun ? readTodo(_folder) : null;
    for (final (i, item) in (_todo?.items ?? <TodoItem>[]).indexed) {
      _answers[i] = TextEditingController(text: item.notes);
    }
  }

  void _continueFromTodo() {
    final todo = _todo!;
    for (final (i, item) in todo.items.indexed) {
      item.notes = _answers[i]!.text;
    }
    writeTodo(_folder, todo.header, todo.items);
    setState(() => _todo = null);
    _start(resume: true);
  }

  @override
  void dispose() {
    _runner?.stop();
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _loadTeam() async {
    setState(() {
      _team = [];
      _teamError = null;
    });
    try {
      final team = await GraphworkRunner(_projectDir.text.trim()).describe(_example.file);
      setState(() => _team = team);
    } catch (e) {
      setState(() => _teamError = '$e'.replaceFirst('Exception: ', ''));
    }
  }

  bool get _hasSavedRun => checkpointFile(_workFolder.text.trim()).existsSync();

  void _start({bool? resume}) {
    final task = _task.text.trim();
    if (task.isEmpty) return;
    final runner = GraphworkRunner(_projectDir.text.trim());
    setState(() {
      _runner = runner;
      _status.clear();
      _runs.clear();
      _log.clear();
      _result = null;
      _runError = null;
      _log.add(LogLine('Starting: ${_example.label}${_mock ? ' (dry run)' : ''}'));
    });
    _sub = runner.run(
      example: _example.file,
      task: task,
      mock: _mock,
      workFolder: _workFolder.text.trim(),
      resume: resume,
      existing: _existing && hasExistingCode(_folder),
    ).listen(
      _onEvent,
      onError: (Object e) => _onEvent({'type': 'error', 'message': '$e'.replaceFirst('Exception: ', '')}),
      onDone: () => setState(() => _sub = null),
    );
  }

  void _onEvent(Map<String, dynamic> e) {
    setState(() {
      switch (e['type']) {
        case 'node_start':
          final node = e['node'] as String;
          _status[node] = NodeStatus.running;
          _log.add(LogLine('▶ $node started', kind: LogKind.start));
        case 'node_end':
          final node = e['node'] as String;
          _status[node] = NodeStatus.done;
          _runs[node] = (_runs[node] ?? 0) + 1;
          final secs = ((e['ms'] as num) / 1000).toStringAsFixed(1);
          _log.add(LogLine('✓ $node finished (${secs}s)', kind: LogKind.done));
        case 'route':
          final from = e['from'] as String;
          if (from != '__start__') {
            final to = (e['to'] as List).map((t) => t == '__end__' ? 'end' : t).join(', ');
            _log.add(LogLine('↳ $from → $to', kind: LogKind.route));
          }
        case 'log':
          final message = e['message'] as String;
          final warn = message.contains(' failed (attempt ') ||
              message.contains(' gave up, continuing') ||
              message.contains('usage limit reached');
          _log.add(LogLine('${warn ? '⚠' : '·'} ${e['node']}: $message', kind: warn ? LogKind.warn : LogKind.info));
        case 'awaiting_human':
          _log.add(LogLine('⏸ Waiting for you: see the to-do list', kind: LogKind.warn));
          _loadTodo();
        case 'done':
          _result = (e['state'] as Map).cast<String, dynamic>();
          _log.add(LogLine('Done (${e['steps']} steps)', kind: LogKind.done));
        case 'error':
          _runError = e['message'] as String;
          _status.updateAll((_, s) => s == NodeStatus.running ? NodeStatus.failed : s);
          _log.add(LogLine('✖ ${e['message']}', kind: LogKind.error));
        case 'raw':
          _log.add(LogLine(e['line'] as String, kind: LogKind.raw));
        case 'exit':
          if (e['code'] != 0 && _runError == null) {
            _runError = 'Process exited with code ${e['code']}';
            _log.add(LogLine('✖ $_runError', kind: LogKind.error));
          }
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_logScroll.hasClients) _logScroll.jumpTo(_logScroll.position.maxScrollExtent);
    });
  }

  void _openWorkspace() {
    final dir = _workFolder.text.trim();
    if (Directory(dir).existsSync()) Process.run('open', [dir]);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: scheme.surface,
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(width: 340, child: _sidebar(context)),
          VerticalDivider(width: 1, color: scheme.outlineVariant),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Team', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 12),
                  _teamBoard(context),
                  const SizedBox(height: 20),
                  Expanded(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(flex: 3, child: _logPanel(context)),
                        const SizedBox(width: 16),
                        Expanded(flex: 2, child: _resultPanel(context)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _sidebar(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    return Container(
      color: scheme.surfaceContainerLow,
      padding: const EdgeInsets.all(20),
      child: ListView(
        children: [
          Text('graphwork', style: text.headlineSmall?.copyWith(fontWeight: FontWeight.w600)),
          Text('Multi-agent software team', style: text.bodyMedium?.copyWith(color: scheme.onSurfaceVariant)),
          const SizedBox(height: 28),
          if (examples.length > 1) ...[
            Text('Team type', style: text.labelLarge),
            const SizedBox(height: 8),
            SegmentedButton<Example>(
              segments: [for (final ex in examples) ButtonSegment(value: ex, label: Text(ex.label))],
              selected: {_example},
              onSelectionChanged: _running
                  ? null
                  : (s) {
                      setState(() => _example = s.first);
                      _loadTeam();
                    },
            ),
            const SizedBox(height: 6),
          ],
          Text(_example.description, style: text.bodySmall?.copyWith(color: scheme.onSurfaceVariant)),
          const SizedBox(height: 24),
          Text('Project folder', style: text.labelLarge),
          const SizedBox(height: 8),
          TextField(
            controller: _workFolder,
            onChanged: (_) => setState(_loadTodo),
            enabled: !_running,
            style: const TextStyle(fontSize: 13),
            decoration: const InputDecoration(
              border: OutlineInputBorder(),
              isDense: true,
              helperText: 'Where the team builds. Created if missing.',
            ),
          ),
          const SizedBox(height: 24),
          Text('Task', style: text.labelLarge),
          const SizedBox(height: 8),
          TextField(
            controller: _task,
            enabled: !_running,
            minLines: 5,
            maxLines: 10,
            decoration: const InputDecoration(
              border: OutlineInputBorder(),
              hintText: 'What should the team build?',
            ),
          ),
          const SizedBox(height: 16),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _mock,
            onChanged: _running ? null : (v) => setState(() => _mock = v),
            title: const Text('Dry run'),
            subtitle: Text(
              _mock ? 'Free: no agent CLIs are called' : 'Real run: uses your subscriptions',
              style: TextStyle(color: _mock ? null : scheme.error),
            ),
          ),
          if (!_running && !_hasSavedRun && hasExistingCode(_folder))
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: _existing,
              onChanged: (v) => setState(() => _existing = v),
              title: const Text('Build on the existing code'),
              subtitle: Text(
                _existing
                    ? 'This folder has code: the team reviews and improves it instead of rebuilding it'
                    : 'The team plans and builds from scratch, even though this folder has code',
              ),
            ),
          const SizedBox(height: 16),
          if (_running)
            OutlinedButton.icon(
              onPressed: () => _runner?.stop(),
              icon: const Icon(Icons.stop),
              label: const Text('Stop'),
            )
          else if (_hasSavedRun) ...[
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: scheme.secondaryContainer,
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Text('An interrupted run is saved in this folder. Resume continues where it stopped.'),
            ),
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: _team.isEmpty ? null : () => _start(resume: true),
              icon: const Icon(Icons.play_arrow),
              label: const Text('Resume'),
            ),
            const SizedBox(height: 6),
            TextButton(
              onPressed: _team.isEmpty ? null : () => _start(resume: false),
              child: const Text('Start over (discards the saved run)'),
            ),
          ] else
            FilledButton.icon(
              onPressed: _team.isEmpty ? null : _start,
              icon: const Icon(Icons.play_arrow),
              label: const Text('Run'),
            ),
          const SizedBox(height: 32),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text('Settings', style: text.labelLarge),
            children: [
              TextField(
                controller: _projectDir,
                enabled: !_running,
                decoration: const InputDecoration(labelText: 'graphwork folder', border: OutlineInputBorder()),
                onSubmitted: (_) => _loadTeam(),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _teamBoard(BuildContext context) {
    if (_teamError != null) {
      return _notice(context, Icons.error_outline, 'Could not load the team: $_teamError');
    }
    if (_team.isEmpty) return const LinearProgressIndicator();
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final (i, node) in _team.indexed) ...[
            if (i > 0)
              Padding(
                padding: const EdgeInsets.only(top: 22),
                child: Icon(Icons.arrow_forward, color: Theme.of(context).colorScheme.outline),
              ),
            Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: _teamCard(context, node)),
          ],
        ],
      ),
    );
  }

  Widget _teamCard(BuildContext context, TeamNode node) {
    final scheme = Theme.of(context).colorScheme;
    final status = _status[node.path] ?? NodeStatus.waiting;
    final accent = agentColors[node.agents.firstOrNull] ?? scheme.primary;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      width: 230,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: status == NodeStatus.running ? accent : scheme.outlineVariant,
          width: status == NodeStatus.running ? 2 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(node.name, style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
              ),
              _statusIcon(context, status, _runs[node.path] ?? 0),
            ],
          ),
          const SizedBox(height: 6),
          Wrap(spacing: 4, children: [for (final a in node.agents) _agentBadge(a)]),
          if (node.children.isNotEmpty) ...[
            const SizedBox(height: 10),
            for (final child in node.children) _memberRow(context, child),
          ],
        ],
      ),
    );
  }

  Widget _memberRow(BuildContext context, TeamNode node) {
    final status = _status[node.path] ?? NodeStatus.waiting;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox(width: 22, child: _statusIcon(context, status, _runs[node.path] ?? 0, small: true)),
          const SizedBox(width: 6),
          Expanded(child: Text(node.name)),
          if ((_runs[node.path] ?? 0) > 1)
            Text('${_runs[node.path]}×', style: Theme.of(context).textTheme.labelSmall),
        ],
      ),
    );
  }

  Widget _statusIcon(BuildContext context, NodeStatus status, int runs, {bool small = false}) {
    final scheme = Theme.of(context).colorScheme;
    final size = small ? 16.0 : 20.0;
    return switch (status) {
      NodeStatus.running => SizedBox(width: size, height: size, child: const CircularProgressIndicator(strokeWidth: 2)),
      NodeStatus.done => Icon(Icons.check_circle, size: size, color: Colors.green.shade600),
      NodeStatus.failed => Icon(Icons.cancel, size: size, color: scheme.error),
      NodeStatus.waiting => Icon(Icons.radio_button_unchecked, size: size, color: scheme.outline),
    };
  }

  Widget _agentBadge(String agent) {
    final color = agentColors[agent] ?? Colors.grey;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(20)),
      child: Text(agentLabels[agent] ?? agent, style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w600)),
    );
  }

  Widget _logPanel(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    Color colorFor(LogKind k) => switch (k) {
          LogKind.start => scheme.primary,
          LogKind.done => Colors.green.shade600,
          LogKind.route => scheme.onSurfaceVariant,
          LogKind.raw => scheme.outline,
          LogKind.warn => Colors.orange.shade700,
          LogKind.error => scheme.error,
          LogKind.info => scheme.onSurface,
        };
    return _panel(
      context,
      'Activity',
      _log.isEmpty
          ? Center(child: Text('Not run yet', style: TextStyle(color: scheme.outline)))
          : ListView.builder(
              controller: _logScroll,
              itemCount: _log.length,
              itemBuilder: (_, i) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 1),
                child: SelectableText(
                  _log[i].text,
                  style: TextStyle(fontFamily: 'Menlo', fontSize: 12, color: colorFor(_log[i].kind)),
                ),
              ),
            ),
    );
  }

  Widget _resultPanel(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final r = _result;
    Widget body;
    if (_todo != null && !_running) {
      return _panel(context, 'To do for you', _todoPanel(context));
    }
    if (_runError != null) {
      body = _notice(context, Icons.error_outline, _runError!);
    } else if (r == null) {
      body = Center(
        child: Text(_running ? 'The team is working…' : 'The result will appear here', style: TextStyle(color: scheme.outline)),
      );
    } else {
      final status = '${r['status'] ?? ''}';
      final done = status == 'DONE' || r['accepted'] == true;
      body = ListView(
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              Chip(
                avatar: Icon(done ? Icons.verified : Icons.warning_amber, size: 18),
                label: Text(r['accepted'] == true ? 'Accepted by you' : done ? 'Definition of Done met' : 'Not done'),
              ),
              if (r['sprint'] != null) Chip(label: Text('${r['sprint']} sprint${r['sprint'] == 1 ? '' : 's'}')),
              if (r['testsPass'] != null) Chip(label: Text(r['testsPass'] == true ? 'Tests pass' : 'Tests failing')),
            ],
          ),
          const SizedBox(height: 16),
          Wrap(spacing: 8, runSpacing: 8, children: [
            if (handoffFile(_folder).existsSync())
              FilledButton.tonalIcon(
                onPressed: () => Process.run('open', [handoffFile(_folder).path]),
                icon: const Icon(Icons.description_outlined),
                label: const Text('Open hand-over'),
              ),
            OutlinedButton.icon(
              onPressed: _openWorkspace,
              icon: const Icon(Icons.folder_open),
              label: const Text('Open code in Finder'),
            ),
          ]),
        ],
      );
    }
    return _panel(context, 'Result', body);
  }

  Widget _todoPanel(BuildContext context) {
    final todo = _todo!;
    final allTicked = todo.items.every((i) => i.done);
    return ListView(
      children: [
        Text('The team needs you before it can go on. Tick each item and answer it if needed.',
            style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
        const SizedBox(height: 8),
        for (final (i, item) in todo.items.indexed) ...[
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: item.done,
            onChanged: (v) => setState(() => item.done = v ?? false),
            title: Text(item.text),
          ),
          Padding(
            padding: const EdgeInsets.only(left: 40, bottom: 8),
            child: TextField(
              controller: _answers[i],
              minLines: 1,
              maxLines: 4,
              decoration: const InputDecoration(isDense: true, border: OutlineInputBorder(), hintText: 'Answer or note (optional)'),
            ),
          ),
        ],
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          FilledButton.icon(
            onPressed: allTicked ? _continueFromTodo : null,
            icon: const Icon(Icons.play_arrow),
            label: const Text('Save & continue'),
          ),
          if (handoffFile(_folder).existsSync())
            OutlinedButton.icon(
              onPressed: () => Process.run('open', [handoffFile(_folder).path]),
              icon: const Icon(Icons.description_outlined),
              label: const Text('Open hand-over'),
            ),
        ]),
        if (!allTicked)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text('Tick every item to continue.', style: Theme.of(context).textTheme.bodySmall),
          ),
      ],
    );
  }

  Widget _panel(BuildContext context, String title, Widget child) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          Expanded(child: child),
        ],
      ),
    );
  }

  Widget _notice(BuildContext context, IconData icon, String message) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: scheme.error),
        const SizedBox(width: 8),
        Expanded(child: SelectableText(message, style: TextStyle(color: scheme.error))),
      ],
    );
  }
}
