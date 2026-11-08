// BackgroundDownloadTransport.swift — the real DownloadTransport: a background URLSession.
//
// Downloads keep running while the app is suspended; if iOS relaunches the app to deliver results,
// `urlSession(_:downloadTask:didFinishDownloadingTo:)` still arrives here and the engine installs the file.
// Foundation only (MondropKit is also compiled into the share extension and the macOS targets).

import Foundation

public final class BackgroundDownloadTransport: NSObject, DownloadTransport, URLSessionDownloadDelegate, @unchecked Sendable {
    public static let sessionIdentifier = "it.mikesoft.mondrop.sync"

    public static let shared = BackgroundDownloadTransport(staging: { OfflineStore.shared.stagingURL() })

    public weak var handler: DownloadTransportHandler?

    private let staging: () -> URL
    private let delegateQueue: OperationQueue
    private let lock = NSLock()
    private var backgroundCompletion: (() -> Void)?

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false                 // the user asked for these now
        config.httpMaximumConnectionsPerHost = 2
        config.timeoutIntervalForResource = 24 * 3600
        // Cellular is decided PER REQUEST (see SyncEngine.makeRequest): Wi-Fi only by default, and flipping the
        // Settings toggle must not need a new session. A session-level `false` would win over any request.
        config.allowsCellularAccess = true
        config.waitsForConnectivity = true
        return URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
    }()

    public init(staging: @escaping () -> URL) {
        self.staging = staging
        self.delegateQueue = OperationQueue()
        self.delegateQueue.maxConcurrentOperationCount = 1
        self.delegateQueue.name = "it.mikesoft.mondrop.sync.delegate"
        super.init()
    }

    // MARK: - DownloadTransport

    public func start(_ job: TransportJob) {
        let task: URLSessionDownloadTask
        if let data = job.resumeData {
            task = session.downloadTask(withResumeData: data)
        } else {
            task = session.downloadTask(with: job.request)
        }
        task.taskDescription = Self.encode(job.info)
        task.resume()
    }

    public func cancel(songKey: String) {
        session.getAllTasks { tasks in
            for task in tasks where Self.info(of: task)?.songKey == songKey { task.cancel() }
        }
    }

    public func reattach(_ completion: @escaping @Sendable ([JobInfo]) -> Void) {
        session.getAllTasks { tasks in
            let alive = tasks.compactMap { task -> JobInfo? in
                guard task is URLSessionDownloadTask, task.state == .running || task.state == .suspended else { return nil }
                return Self.info(of: task)
            }
            completion(alive)
        }
    }

    /// AppDelegate hands over the system completion handler; it must be called once the session is done with events.
    public func setBackgroundCompletion(_ completion: @escaping () -> Void) {
        lock.lock(); defer { lock.unlock() }
        backgroundCompletion = completion
    }

    // MARK: - URLSessionDownloadDelegate

    public func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard let info = Self.info(of: downloadTask) else { return }
        let fraction: Double? = totalBytesExpectedToWrite > 0
            ? min(1, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
            : nil
        handler?.transportProgress(songKey: info.songKey, fraction: fraction)
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let info = Self.info(of: downloadTask) else {
            try? FileManager.default.removeItem(at: location)
            return
        }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode
        // The system deletes `location` when this returns: move it into our own staging directory NOW.
        let destination = staging()
        do {
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: location, to: destination)
        } catch {
            handler?.transportFailed(
                info: info,
                message: "salvataggio temporaneo non riuscito",
                resumeData: nil,
                requestURL: downloadTask.originalRequest?.url,
                cancelled: false
            )
            return
        }
        handler?.transportFinished(info: info, stagedFile: destination, httpStatus: status)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, let info = Self.info(of: task) else { return }   // success is handled in didFinishDownloadingTo
        let nsError = error as NSError
        let resume = nsError.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        let cancelled = nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
        handler?.transportFailed(
            info: info,
            message: Self.friendlyMessage(for: nsError),
            resumeData: resume,
            requestURL: task.originalRequest?.url,
            cancelled: cancelled
        )
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock()
        let completion = backgroundCompletion
        backgroundCompletion = nil
        lock.unlock()
        DispatchQueue.main.async { completion?() }
    }

    // MARK: - Helpers

    static func encode(_ info: JobInfo) -> String? {
        guard let data = try? JSONEncoder().encode(info) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func info(of task: URLSessionTask) -> JobInfo? {
        guard let text = task.taskDescription, let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JobInfo.self, from: data)
    }

    /// Short Italian reasons for the row ("errore: …"). Public so the wording is testable.
    public static func friendlyMessage(for error: NSError) -> String {
        guard error.domain == NSURLErrorDomain else { return error.localizedDescription }
        switch error.code {
        case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost:
            return "rete non disponibile"
        case NSURLErrorDataNotAllowed:
            return "serve il Wi-Fi (o abilita la rete cellulare nelle Impostazioni)"
        case NSURLErrorTimedOut:
            return "timeout"
        case NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorDNSLookupFailed:
            return "server non raggiungibile"
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted, NSURLErrorAppTransportSecurityRequiresSecureConnection:
            return "connessione protetta non riuscita"
        case NSURLErrorCancelled:
            return "annullato"
        default:
            return error.localizedDescription
        }
    }
}
