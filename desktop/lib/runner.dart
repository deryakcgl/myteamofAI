import 'dart:async';
import 'dart:convert';
import 'dart:io';

final String home = Platform.environment['HOME'] ?? '';

String get defaultProjectDir => '$home/graphwork';

String get defaultWorkFolder => '$home/graphwork-projects/default';

const mockDelayMs = 600;

Map<String, String> _environment({required bool mock, String? workFolder}) {
  final path = [
    '$home/.local/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    Platform.environment['PATH'] ?? '/usr/bin:/bin',
  ].join(':');
  return {'PATH': path, 'GRAPHWORK_PROJECT': ?workFolder, if (mock) ...{'GRAPHWORK_MOCK': '1', 'GRAPHWORK_MOCK_DELAY_MS': '$mockDelayMs'}};
}

String? _findNode() {
  for (final dir in _environment(mock: false)['PATH']!.split(':')) {
    final candidate = File('$dir/node');
    if (candidate.existsSync()) return candidate.path;
  }
  return null;
}

File checkpointFile(String workFolder) => File('$workFolder/.graphwork/checkpoint.json');

class TeamNode {
  TeamNode({required this.path, required this.name, this.agent, this.children = const []});

  final String path;
  final String name;
  final String? agent;
  final List<TeamNode> children;

  List<String> get agents {
    if (agent != null) return [agent!];
    return children.expand((c) => c.agents).toSet().toList();
  }

  static List<TeamNode> fromDescription(Map<String, dynamic> graph, [String prefix = '']) {
    return [
      for (final n in (graph['nodes'] as List).cast<Map<String, dynamic>>())
        TeamNode(
          path: '$prefix${n['name']}',
          name: n['name'] as String,
          agent: (n['meta'] as Map?)?['agent'] as String?,
          children: n['children'] == null
              ? const []
              : fromDescription(n['children'] as Map<String, dynamic>, '$prefix${n['name']}/'),
        ),
    ];
  }
}

class GraphworkRunner {
  GraphworkRunner(this.projectDir);

  final String projectDir;
  Process? _process;

  bool get isRunning => _process != null;

  Future<List<String>> _args(String example, List<String> rest) async {
    if (!await File('$projectDir/examples/$example').exists()) {
      throw Exception('examples/$example not found in $projectDir');
    }
    return ['--import', 'tsx', 'examples/$example', ...rest];
  }

  String _node() {
    final node = _findNode();
    if (node == null) throw Exception('Node.js not found. Install it with: brew install node');
    return node;
  }

  Future<List<TeamNode>> describe(String example) async {
    final result = await Process.run(
      _node(),
      await _args(example, ['--describe']),
      workingDirectory: projectDir,
      environment: _environment(mock: true),
    );
    if (result.exitCode != 0) {
      throw Exception((result.stderr as String).trim().split('\n').last);
    }
    final json = jsonDecode((result.stdout as String).trim()) as Map<String, dynamic>;
    return TeamNode.fromDescription(json);
  }

  Stream<Map<String, dynamic>> run({
    required String example,
    required String task,
    required bool mock,
    String? workFolder,
    bool? resume,
    bool existing = false,
  }) async* {
    final process = await Process.start(
      _node(),
      await _args(example, ['--json', if (resume == true) '--resume', if (resume == false) '--fresh', if (existing) '--existing', task]),
      workingDirectory: projectDir,
      environment: _environment(mock: mock, workFolder: workFolder),
    );
    _process = process;
    unawaited(process.stdin.close());

    final controller = StreamController<Map<String, dynamic>>();
    Map<String, dynamic> parse(String line) {
      Object? value;
      try {
        value = jsonDecode(line);
      } on FormatException {
        value = null;
      }
      return value is Map<String, dynamic> && value['type'] is String ? value : {'type': 'raw', 'line': line};
    }

    final outDone = Completer<void>(), errDone = Completer<void>();
    process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) => controller.add(parse(line)), onDone: outDone.complete);
    process.stderr
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) => controller.add({'type': 'raw', 'line': line, 'stderr': true}), onDone: errDone.complete);
    unawaited(process.exitCode.then((code) async {
      await Future.wait([outDone.future, errDone.future]);
      controller.add({'type': 'exit', 'code': code});
      _process = null;
      await controller.close();
    }));

    yield* controller.stream;
  }

  bool _stopping = false;

  void stop() {
    if (_stopping) return;
    _stopping = _process?.kill(ProcessSignal.sigterm) ?? false;
  }
}

class TodoItem {
  TodoItem(this.text, {this.done = false, this.notes = ''});
  final String text;
  bool done;
  String notes;
}

bool hasExistingCode(String workFolder) {
  final dir = Directory(workFolder);
  if (!dir.existsSync()) return false;
  const ours = {'.claude', '.graphwork', '.DS_Store', 'reports', 'todo', 'BACKLOG.md', 'HANDOFF.md', 'TODO.md'};
  return dir.listSync().any((e) => !ours.contains(e.uri.pathSegments.where((p) => p.isNotEmpty).last));
}

File todoFile(String workFolder) => File('$workFolder/TODO.md');
File handoffFile(String workFolder) => File('$workFolder/HANDOFF.md');

({String header, List<TodoItem> items})? readTodo(String workFolder) {
  final file = todoFile(workFolder);
  if (!file.existsSync()) return null;
  final lines = file.readAsLinesSync();
  final first = lines.indexWhere((l) => RegExp(r'^\s*[-*] \[( |x|X)\]').hasMatch(l));
  if (first < 0) return null;
  final items = <TodoItem>[];
  for (final line in lines.skip(first)) {
    final m = RegExp(r'^\s*[-*] \[( |x|X)\]\s+(.*)$').firstMatch(line);
    if (m != null) {
      items.add(TodoItem(m.group(2)!.trim(), done: m.group(1) != ' '));
    } else if (items.isNotEmpty && RegExp(r'^\s+\S').hasMatch(line)) {
      final note = line.trim().replaceFirst(RegExp(r'^Answer:\s*', caseSensitive: false), '');
      if (note.isNotEmpty) items.last.notes = items.last.notes.isEmpty ? note : '${items.last.notes}\n$note';
    }
  }
  return (header: lines.take(first).join('\n'), items: items);
}

void writeTodo(String workFolder, String header, List<TodoItem> items) {
  final body = items.map((i) {
    final notes = i.notes.trim().split('\n');
    return [
      '- [${i.done ? 'x' : ' '}] ${i.text}',
      '  Answer: ${notes.first}',
      for (final more in notes.skip(1)) '  $more',
      '',
    ].join('\n');
  }).join('\n');
  todoFile(workFolder).writeAsStringSync('$header\n$body');
}
