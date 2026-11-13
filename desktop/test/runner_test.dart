import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:graphwork_desktop/runner.dart';

void main() {
  final projectDir = '${Uri.base.toFilePath()}..';

  String freshFolder(String name) {
    final dir = Directory('${Directory.systemTemp.path}/$name');
    if (dir.existsSync()) dir.deleteSync(recursive: true);
    return dir.path;
  }

  test('describe returns the nested team structure', () async {
    final team = await GraphworkRunner(projectDir).describe('team-of-teams.ts');
    expect(team.map((t) => t.name), ['planning', 'sprint', 'audit', 'triage', 'record', 'handoff', 'owner']);
    expect(team[0].children.map((c) => c.name), ['requirements', 'design']);
    expect(team[1].children.map((c) => c.name), containsAll(['simplifier', 'test-engineer']));
    expect(team[2].children.map((c) => c.name), containsAll(['verification', 'cyber', 'quality', 'codex-report', 'cursor-report']));
    expect(team[2].agents, containsAll(['claude', 'codex', 'cursor']));
  });

  test('a mock run stops on a to-do list, and continuing after ticking it finishes', () async {
    final folder = freshFolder('graphwork-test-project');
    const task = 'görev with "quotes" & \$(no shell)';

    final first = await GraphworkRunner(projectDir).run(example: 'team-of-teams.ts', task: task, mock: true, workFolder: folder).toList();
    expect(first.where((e) => e['type'] == 'node_end').map((e) => e['node']), contains('audit/codex-report'));
    expect(first.any((e) => e['type'] == 'awaiting_human'), isTrue);
    expect(first.last, {'type': 'exit', 'code': 0});

    final todo = readTodo(folder)!;
    expect(todo.items.single.done, isFalse);
    todo.items.single
      ..done = true
      ..notes = 'yes, 2 spaces';
    writeTodo(folder, todo.header, todo.items);

    final second = await GraphworkRunner(projectDir)
        .run(example: 'team-of-teams.ts', task: task, mock: true, workFolder: folder, resume: true)
        .toList();
    final done = second.firstWhere((e) => e['type'] == 'done');
    expect((done['state'] as Map)['status'], 'DONE');
    expect((done['state'] as Map)['task'], task);
    expect('${(done['state'] as Map)['answers']}', contains('yes, 2 spaces'));
    expect(handoffFile(folder).existsSync(), isTrue);
    expect(todoFile(folder).existsSync(), isFalse);
    Directory(folder).deleteSync(recursive: true);
  }, timeout: const Timeout(Duration(minutes: 3)));

  test('stop() saves the run, and resume continues it', () async {
    final folder = freshFolder('graphwork-test-stop');
    final runner = GraphworkRunner(projectDir);
    final events = <Map<String, dynamic>>[];
    await runner.run(example: 'team-of-teams.ts', task: 'x', mock: true, workFolder: folder).forEach((e) {
      events.add(e);
      if (e['node'] == 'sprint') runner.stop();
    }).timeout(const Duration(seconds: 60));
    expect(events.any((e) => e['type'] == 'error' && e['message'] == 'Stopped'), isTrue);
    expect(events.last['code'], isNot(0));
    expect(checkpointFile(folder).existsSync(), isTrue);

    final resumed = await GraphworkRunner(projectDir)
        .run(example: 'team-of-teams.ts', task: 'x', mock: true, workFolder: folder, resume: true)
        .toList();
    expect(resumed.any((e) => e['type'] == 'log' && '${e['message']}'.startsWith('resuming')), isTrue);
    expect(resumed.where((e) => e['type'] == 'node_start').map((e) => e['node']), isNot(contains('planning')));
    expect(resumed.any((e) => e['type'] == 'awaiting_human'), isTrue);
    Directory(folder).deleteSync(recursive: true);
  }, timeout: const Timeout(Duration(minutes: 3)));

  test('TODO.md parsing keeps the header and multi-line answers', () {
    final folder = freshFolder('graphwork-test-todo');
    Directory(folder).createSync();
    todoFile(folder).writeAsStringSync('<!-- graphwork-todo: sprint-2 -->\n# To do\n\n- [ ] A\n  Answer: \n\n- [x] B\n  Answer: one\n  two\n');
    final todo = readTodo(folder)!;
    expect(todo.items.map((i) => [i.text, i.done, i.notes]), [
      ['A', false, ''],
      ['B', true, 'one\ntwo'],
    ]);
    writeTodo(folder, todo.header, todo.items);
    expect(todoFile(folder).readAsStringSync(), startsWith('<!-- graphwork-todo: sprint-2 -->'));
    expect(readTodo(folder)!.items[1].notes, 'one\ntwo');
    Directory(folder).deleteSync(recursive: true);
  });
}
