import { AppError, missing, forbidden, invalidState } from './errors.js';

// TODO-01~04: 업무 규칙과 트랜잭션을 직접 구현합니다. docs/API.md를 먼저 읽으세요.
// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 상태 변경과 이력 저장은 함께 성공하거나 함께 실패해야 합니다.
// 승인 취소와 자동 승급은 신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.
export function createApplicationService(repo) {
  return {
    apply(actor,eventId) {
      // TODO-01: 행사·학생 역할·중복 검사 → PENDING 저장 + APPLY 이력.
      // 취소·승인 취소 기록도 중복입니다. 반환: 신청 객체.

      let id = actor.id
    
      if (!repo.event(eventId))
        throw missing();
      if (actor.role === 'MANAGER')
        throw forbidden();
      if (repo.existing(eventId, id))
        throw new AppError(409, 'ALREADY_APPLIED', '중복 요청입니다.')

      let applicationId = null
      repo.db.exec('BEGIN');
      try {
        applicationId = repo.insert(eventId, id).id;  
        repo.addHistory({applicationId, actorId: id, action:'APPLY', toStatus:'PENDING'})

        repo.db.exec('COMMIT');
      } catch(e) { repo.db.exec('ROLLBACK'); throw e; }

      return repo.application(applicationId)
    },
    cancel(actor,applicationId) {
      // TODO-02: 본인의 PENDING만 CANCELLED로 변경 + CANCEL 이력.
      // 학생의 대기 취소는 승인 자리를 비우지 않으므로 자동 승급하지 않습니다.

      let id = actor.id
      let app = repo.application(applicationId)

      if (!app)
        throw new AppError(404, 'NOT_FOUND', "올바르지 않은 요청입니다.")
      if (actor.role === 'MANAGER' || actor.id !== app.userId)
        throw forbidden();
      if (app.status !== 'PENDING')
        throw invalidState();

      
      repo.db.exec('BEGIN');
      try {
        repo.setStatus(applicationId, 'CANCELLED')
        repo.addHistory({applicationId, actorId: id, action:'CANCEL', fromStatus: 'PENDING', toStatus:'CANCELLED'})

        repo.db.exec('COMMIT');
      } catch(e) { repo.db.exec('ROLLBACK'); throw e; }
      return repo.application(applicationId)
    },
    approve(actor,applicationId) {
      // TODO-03: 담당자·PENDING·정원 검사 → APPROVED + APPROVE 이력.
      // 직접 승인은 운영자가 선택합니다. FIFO는 승인 취소 때의 자동 승급에 적용합니다.
      
      let id = actor.id
      let app = repo.application(applicationId)

      if (!app)
        throw new AppError(404, 'NOT_FOUND', "올바르지 않은 요청입니다.")

      let eve = repo.event(app.eventId)

      if (actor.role !== 'MANAGER' || actor.id !== eve.managerId)
        throw forbidden();
      if (app.status !== 'PENDING')
        throw invalidState();
      if (repo.approvedCount(eve.id) == eve.capacity)
        throw new AppError(409, 'CAPACITY_FULL', '정원 초과 요청입니다.')

      repo.db.exec('BEGIN');
      try {
        repo.setStatus(applicationId, 'APPROVED')
        repo.addHistory({applicationId, actorId: id, action:'APPROVE', fromStatus: 'PENDING', toStatus:'APPROVED'})

        repo.db.exec('COMMIT');
      } catch(e) { repo.db.exec('ROLLBACK'); throw e; }
      return repo.application(applicationId)
    },
    revoke(actor,applicationId,reason) {
      // TODO-04: 담당자·APPROVED 검사 → REVOKED + REVOKE 이력.
      // 같은 행사 PENDING 중 created_at ASC, id ASC 첫 1건을 자동 승인합니다.
      // AUTO_APPROVE 이력의 causeHistoryId는 이 요청의 REVOKE 이력 ID입니다.
      // 상태와 이력의 부분 저장을 막고, 거부·오류 시 전체를 되돌리세요.
      // 반환: {revoked: 신청 객체, promoted: 신청 객체 또는 null}.

      let id = actor.id;
      let app = repo.application(applicationId)
      let eve = repo.event(app.eventId)

      if (!app)
        throw new AppError(404, 'NOT_FOUND', "올바르지 않은 요청입니다.")
      if (actor.role !== 'MANAGER' || actor.id !== eve.managerId)
        throw forbidden();
      if (app.status !== 'APPROVED')
        throw invalidState();

      let app_next = null
      repo.db.exec('BEGIN');
      try {
        repo.setStatus(applicationId, 'REVOKED')
        let hist = repo.addHistory({applicationId, actorId: id, action:'REVOKE', fromStatus: 'APPROVED', toStatus:'REVOKED', reason: reason})

        app_next = repo.getNext(app.eventId);
        if (app_next)
        {
          repo.setStatus(app_next.id, 'APPROVED')
          repo.addHistory({applicationId: app_next.id, actorId: id, action:'AUTO_APPROVE', fromStatus: 'PENDING', toStatus:'APPROVED', causeHistoryId: hist})
        }

        repo.db.exec('COMMIT');
      } catch(e) { repo.db.exec('ROLLBACK'); throw e; }

      return {revoked: repo.application(applicationId), promoted: app_next === undefined ? null : repo.application(app_next.id)}
    }
  };
}
