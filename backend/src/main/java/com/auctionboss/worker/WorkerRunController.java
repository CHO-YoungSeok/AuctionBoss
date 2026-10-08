package com.auctionboss.worker;

import java.util.regex.Pattern;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 워커 회차 API. 원본 Next.js 라우트({@code /api/worker-runs/**})와 같은 계약이다. */
@RestController
@RequestMapping("/api/worker-runs")
public class WorkerRunController {

	private static final Pattern RUN_ID = Pattern.compile("[0-9]+");

	private final WorkerRunService service;

	private final WorkerStatusService statusService;

	public WorkerRunController(WorkerRunService service, WorkerStatusService statusService) {
		this.service = service;
		this.statusService = statusService;
	}

	@PostMapping
	ResponseEntity<StartedRun> start(@RequestBody(required = false) byte[] body) {
		String worker = WorkerRunBodies.parseStart(body);
		return ResponseEntity.status(HttpStatus.CREATED).body(service.start(worker));
	}

	@PatchMapping("/{id}")
	WorkerRunResponse finish(@PathVariable String id, @RequestBody(required = false) byte[] body) {
		// 숫자가 아닌 id는 없는 회차와 같게 404다. 본문 검증보다 먼저 본다(원본과 같은 순서).
		if (!RUN_ID.matcher(id).matches()) {
			throw new WorkerRunNotFoundException(id);
		}
		return service.finish(id, WorkerRunBodies.parseFinish(body));
	}

	@GetMapping
	WorkerRunPage list(@RequestParam MultiValueMap<String, String> params) {
		return service.list(params);
	}

	// 리터럴 경로(summary, status)가 {id} 패턴보다 우선한다.
	@GetMapping("/status")
	WorkerStatusResponse status(@RequestParam MultiValueMap<String, String> params) {
		return statusService.status(params);
	}

	@GetMapping("/summary")
	RunsSummary summary(@RequestParam MultiValueMap<String, String> params) {
		return service.summary(params);
	}

}
