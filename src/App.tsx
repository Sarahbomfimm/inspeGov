import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
    EmailAuthProvider,
    onAuthStateChanged,
    reauthenticateWithCredential,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
    signOut,
    type User,
} from 'firebase/auth'
import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    onSnapshot,
    query,
    updateDoc,
    where,
    writeBatch,
} from 'firebase/firestore'
import { auth, db, firebaseReady } from './firebase'
import './App.css'

type HotelKey = 'praia' | 'express'
type InspectionStatus = 'Conforme' | 'Retrabalho'
type NoticeType = 'sucesso' | 'aviso' | 'info'
type ViewStatusFilter = 'Todos' | InspectionStatus
type ReworkExecutionFilter = 'Todos' | 'Pendentes' | 'Executados'
type ViewPreset = 'today' | 'week' | 'month' | null
type ConfirmAction = 'excluir' | 'limpar'
type WorkspaceView = 'overview' | 'inspections'
type InspectionSection = 'report' | 'register'

interface InspectionRecord {
    id: number
    firestoreId?: string
    ownerId?: string
    createdAt?: string
    updatedAt?: string
    createdByEmail?: string
    updatedByEmail?: string
    reworkDone?: boolean
    reworkCompletedAt?: string
    reworkCompletedByEmail?: string
    hotel?: string
    housekeeper: string
    inspector: string
    uh: string
    status: InspectionStatus
    date: string
    month: string
    time: string
    note: string
}

interface NotificationItem {
    id: number
    message: string
    type: NoticeType
}

interface ConfirmDialogState {
    isOpen: boolean
    action: ConfirmAction
    recordId?: string
}

interface DailyTrendItem {
    date: string
    label: string
    total: number
    conformes: number
    retrabalho: number
    height: number
}

interface PriorityRoomItem {
    id: number
    uh: string
    housekeeper: string
    note: string
    daysPending: number
}

const STORAGE_KEY = 'inspegov-inspections-v1'
const RECOVERY_NOTIFICATION_EMAIL = import.meta.env.VITE_RECOVERY_NOTIFICATION_EMAIL?.trim() ?? ''


const PRAIA_ROOM_RANGES: Array<[number, number]> = [
    [100, 115],
    [201, 215],
    [300, 315],
    [401, 415],
    [501, 515],
    [601, 615],
    [700, 715],
    [801, 815],
    [901, 915],
]

const EXPRESS_ROOM_RANGES: Array<[number, number]> = [
    [101, 110],
    [201, 210],
    [301, 308],
    [401, 408],
    [501, 508],
    [601, 608],
    [707, 708],
]

const toTwoDigits = (value: number) => value.toString().padStart(2, '0')

const getNowValues = () => {
    const now = new Date()
    const year = now.getFullYear()
    const month = toTwoDigits(now.getMonth() + 1)
    const day = toTwoDigits(now.getDate())
    const hour = toTwoDigits(now.getHours())
    const minutes = toTwoDigits(now.getMinutes())

    return {
        date: `${year}-${month}-${day}`,
        month: `${year}-${month}`,
        time: `${hour}:${minutes}`,
    }
}

const buildRooms = (ranges: Array<[number, number]>) => {
    const rooms: string[] = []
    ranges.forEach(([start, end]) => {
        for (let room = start; room <= end; room += 1) {
            rooms.push(room.toString())
        }
    })
    return rooms
}

const formatDateBR = (date: string) => {
    const [year, month, day] = date.split('-')
    if (!year || !month || !day) {
        return date
    }
    return `${day}/${month}/${year}`
}

const formatDateTimeBR = (value?: string) => {
    if (!value) {
        return 'Não informado'
    }

    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
        return value
    }

    return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(parsed)
}

const getMonthFromDate = (date: string) => {
    const [year, monthValue] = date.split('-')
    if (!year || !monthValue) {
        return ''
    }
    return `${year}-${monthValue}`
}

const getStatusClassName = (status: InspectionStatus) =>
    status === 'Conforme' ? 'status-conforme' : 'status-retrabalho'

const isReworkPending = (record: InspectionRecord) =>
    record.status === 'Retrabalho' && !record.reworkDone

const getUserInitials = (email: string) => {
    const [localPart] = email.split('@')
    const raw = (localPart ?? '').replace(/[^a-zA-Z]/g, '').toUpperCase()
    return raw.slice(0, 2) || 'AD'
}

const getUserDisplayName = (email: string) => {
    const [localPart] = email.split('@')
    if (!localPart) {
        return 'Administrador'
    }

    return localPart
        .replace(/[._-]+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase())
}

const isInspectionStatus = (value: unknown): value is InspectionStatus =>
    value === 'Conforme' || value === 'Retrabalho'

const getFirebaseErrorMessage = (error: unknown, fallback: string) => {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = String((error as { code?: unknown }).code ?? '')
        if (code) {
            return `${fallback} (${code})`
        }
    }
    return fallback
}

const downloadBlob = (content: BlobPart, fileName: string, type: string) => {
    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    URL.revokeObjectURL(url)
}

const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
}

function App() {
    const [selectedHotel, setSelectedHotel] = useState<HotelKey | null>(null)
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        const saved = localStorage.getItem('inspegov-theme')
        return saved === 'light' || saved === 'dark' ? saved : 'dark'
    })

    useEffect(() => {
        document.body.classList.remove('light-theme', 'dark-theme')
        document.body.classList.add(`${theme}-theme`)
    }, [theme])

    const toggleTheme = () => {
        setTheme((prev) => {
            const next = prev === 'light' ? 'dark' : 'light'
            localStorage.setItem('inspegov-theme', next)
            return next
        })
    }

    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
        return localStorage.getItem('inspegov-sidebar-collapsed') === 'true'
    })

    const toggleSidebarCollapsed = () => {
        setIsSidebarCollapsed((prev) => {
            const next = !prev
            localStorage.setItem('inspegov-sidebar-collapsed', String(next))
            return next
        })
    }

    const rooms = useMemo(() => {
        if (selectedHotel === 'express') return buildRooms(EXPRESS_ROOM_RANGES)
        if (selectedHotel === 'praia') return buildRooms(PRAIA_ROOM_RANGES)
        return []
    }, [selectedHotel])

    const initialNow = useMemo(() => getNowValues(), [])

    const [uh, setUh] = useState(rooms[0] ?? '')
    const [housekeeper, setHousekeeper] = useState('')
    const [inspector, setInspector] = useState('')
    const [status, setStatus] = useState<InspectionStatus>('Conforme')
    const [date, setDate] = useState(initialNow.date)
    const [time, setTime] = useState(initialNow.time)
    const [note, setNote] = useState('')

    const [isPageLoading, setIsPageLoading] = useState(true)
    const [isAuthLoading, setIsAuthLoading] = useState(true)
    const [isRecordsLoading, setIsRecordsLoading] = useState(false)
    const [isSavingNewRecord, setIsSavingNewRecord] = useState(false)
    const [isSavingEdit, setIsSavingEdit] = useState(false)
    const [isLoggedIn, setIsLoggedIn] = useState(false)
    const [currentUser, setCurrentUser] = useState<User | null>(null)
    const [loggedUserEmail, setLoggedUserEmail] = useState('')
    const [loginEmail, setLoginEmail] = useState('')
    const [loginPassword, setLoginPassword] = useState('')
    const [authError, setAuthError] = useState('')
    const [isAuthenticating, setIsAuthenticating] = useState(false)
    const [isLoginTransition, setIsLoginTransition] = useState(false)

    const [editModalOpen, setEditModalOpen] = useState(false)
    const [editingRecordId, setEditingRecordId] = useState<number | null>(null)
    const [editUh, setEditUh] = useState(rooms[0] ?? '')
    const [editHousekeeper, setEditHousekeeper] = useState('')
    const [editInspector, setEditInspector] = useState('')
    const [editStatus, setEditStatus] = useState<InspectionStatus>('Conforme')
    const [editReworkDone, setEditReworkDone] = useState(false)
    const [editDate, setEditDate] = useState(initialNow.date)
    const [editTime, setEditTime] = useState(initialNow.time)
    const [editNote, setEditNote] = useState('')
    const [editRecordAudit, setEditRecordAudit] = useState<InspectionRecord | null>(null)

    const [viewStartDate, setViewStartDate] = useState(initialNow.date)
    const [viewEndDate, setViewEndDate] = useState(initialNow.date)
    const [viewStatus, setViewStatus] = useState<ViewStatusFilter>('Todos')
    const [viewReworkExecution, setViewReworkExecution] = useState<ReworkExecutionFilter>('Todos')
    const [viewSearch, setViewSearch] = useState('')
    const [isFilterActive, setIsFilterActive] = useState(false)
    const [activeViewPreset, setActiveViewPreset] = useState<ViewPreset>(null)
    const [isSidebarOpen, setIsSidebarOpen] = useState(false)
    const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('overview')
    const [inspectionSection, setInspectionSection] = useState<InspectionSection>('report')
    const [currentMonthKey, setCurrentMonthKey] = useState(() => getNowValues().month)
    const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
    const quickSidebarRef = useRef<HTMLElement | null>(null)

    const [isDatePickerOpen, setIsDatePickerOpen] = useState(false)
    const [calendarMonth, setCalendarMonth] = useState(() => new Date())
    const [tempStartDate, setTempStartDate] = useState<string | null>(null)
    const datePickerRef = useRef<HTMLDivElement | null>(null)

    const [notifications, setNotifications] = useState<NotificationItem[]>([])
    const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
        isOpen: false,
        action: 'excluir',
    })
    const [clearRecordsPassword, setClearRecordsPassword] = useState('')
    const [clearRecordsError, setClearRecordsError] = useState('')
    const [isConfirmingClear, setIsConfirmingClear] = useState(false)

    const [records, setRecords] = useState<InspectionRecord[]>(() => {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) {
            return []
        }

        try {
            const parsed = JSON.parse(raw) as InspectionRecord[]
            if (!Array.isArray(parsed)) {
                return []
            }
            return parsed
        } catch {
            return []
        }
    })

    const filteredRecords = useMemo(() => {
        if (!selectedHotel) return []
        return records.filter((record) => (record.hotel ?? 'praia') === selectedHotel)
    }, [records, selectedHotel])

    const viewedRecords = useMemo(
        () =>
            filteredRecords.filter((record) => {
                if (isFilterActive) {
                    if (viewStartDate && record.date < viewStartDate) {
                        return false
                    }

                    if (viewEndDate && record.date > viewEndDate) {
                        return false
                    }

                    if (viewStatus !== 'Todos' && record.status !== viewStatus) {
                        return false
                    }

                    if (viewReworkExecution !== 'Todos') {
                        if (record.status !== 'Retrabalho') {
                            return false
                        }

                        if (viewReworkExecution === 'Pendentes' && record.reworkDone) {
                            return false
                        }

                        if (viewReworkExecution === 'Executados' && !record.reworkDone) {
                            return false
                        }
                    }

                    const searchTerm = viewSearch.trim().toLowerCase()
                    if (searchTerm) {
                        const uhMatch = record.uh.toLowerCase().includes(searchTerm)
                        const noteMatch = record.note.toLowerCase().includes(searchTerm)
                        const housekeeperMatch = (record.housekeeper ?? '').toLowerCase().includes(searchTerm)
                        const inspectorMatch = (record.inspector ?? '').toLowerCase().includes(searchTerm)
                        if (!uhMatch && !noteMatch && !housekeeperMatch && !inspectorMatch) {
                            return false
                        }
                    }
                }

                return true
            }),
        [
            filteredRecords,
            isFilterActive,
            viewStartDate,
            viewEndDate,
            viewStatus,
            viewReworkExecution,
            viewSearch,
        ],
    )

    const currentMonthRecords = useMemo(
        () =>
            filteredRecords.filter((record) => {
                const recordMonth = record.month || getMonthFromDate(record.date)
                return recordMonth === currentMonthKey
            }),
        [filteredRecords, currentMonthKey],
    )

    const monthStats = useMemo(() => {
        const total = currentMonthRecords.length
        const conformes = currentMonthRecords.filter((r) => r.status === 'Conforme').length
        const retrabalho = total - conformes
        const retrabalhoPendente = currentMonthRecords.filter((record) => isReworkPending(record)).length
        const retrabalhoExecutado = currentMonthRecords.filter((record) => record.status === 'Retrabalho' && record.reworkDone).length
        const conformidadePercentual = total > 0 ? Math.round((conformes / total) * 100) : 0

        return {
            total,
            conformes,
            retrabalho,
            retrabalhoPendente,
            retrabalhoExecutado,
            conformidadePercentual,
        }
    }, [currentMonthRecords])

    const currentMonthLabel = useMemo(() => {
        const date = new Date(`${currentMonthKey}-01T00:00:00`)
        const formatted = new Intl.DateTimeFormat('pt-BR', {
            month: 'long',
            year: 'numeric',
        }).format(date)

        return formatted.charAt(0).toUpperCase() + formatted.slice(1)
    }, [currentMonthKey])

    const dashboardAnalytics = useMemo(() => {
        const now = new Date()
        now.setHours(0, 0, 0, 0)
        const targetConformity = 80

        const dayMap = new Map<string, { total: number; conformes: number; retrabalho: number }>()
        const uhRiskMap = new Map<string, { total: number; pendentes: number }>()
        const pendingRooms: PriorityRoomItem[] = []

        currentMonthRecords.forEach((record) => {
            const currentDay = dayMap.get(record.date) ?? { total: 0, conformes: 0, retrabalho: 0 }
            currentDay.total += 1
            if (record.status === 'Conforme') {
                currentDay.conformes += 1
            } else {
                currentDay.retrabalho += 1
            }
            dayMap.set(record.date, currentDay)

            if (record.status === 'Retrabalho') {
                const uhRisk = uhRiskMap.get(record.uh) ?? { total: 0, pendentes: 0 }
                uhRisk.total += 1
                if (!record.reworkDone) {
                    uhRisk.pendentes += 1
                }
                uhRiskMap.set(record.uh, uhRisk)

            }

            if (isReworkPending(record)) {
                const pendingDate = new Date(`${record.date}T00:00:00`)
                pendingDate.setHours(0, 0, 0, 0)
                const diffMs = now.getTime() - pendingDate.getTime()
                const daysPending = Math.max(0, Math.floor(diffMs / 86400000))

                pendingRooms.push({
                    id: record.id,
                    uh: record.uh,
                    housekeeper: record.housekeeper || 'Não informado',
                    note: record.note || 'Sem observação registrada',
                    daysPending,
                })
            }
        })

        const latest7Days: DailyTrendItem[] = []
        for (let offset = 6; offset >= 0; offset -= 1) {
            const date = new Date(now)
            date.setDate(now.getDate() - offset)
            const isoDate = date.toISOString().slice(0, 10)
            const item = dayMap.get(isoDate) ?? { total: 0, conformes: 0, retrabalho: 0 }

            latest7Days.push({
                date: isoDate,
                label: date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
                total: item.total,
                conformes: item.conformes,
                retrabalho: item.retrabalho,
                height: 0,
            })
        }

        const maxTotal = Math.max(...latest7Days.map((day) => day.total), 1)
        const trend = latest7Days.map((day) => ({
            ...day,
            height: day.total === 0 ? 8 : Math.max(12, Math.round((day.total / maxTotal) * 100)),
        }))

        const readWindowTotals = (startOffset: number, endOffset: number) => {
            let total = 0
            let conformes = 0

            for (let offset = startOffset; offset <= endOffset; offset += 1) {
                const date = new Date(now)
                date.setDate(now.getDate() - offset)
                const isoDate = date.toISOString().slice(0, 10)
                const item = dayMap.get(isoDate)

                if (!item) {
                    continue
                }

                total += item.total
                conformes += item.conformes
            }

            return {
                total,
                conformes,
                conformity: total > 0 ? Math.round((conformes / total) * 100) : 0,
            }
        }

        const currentWeek = readWindowTotals(0, 6)
        const previousWeek = readWindowTotals(7, 13)
        const volumeDelta = currentWeek.total - previousWeek.total
        const volumeDeltaPercent =
            previousWeek.total > 0
                ? Math.round((volumeDelta / previousWeek.total) * 100)
                : currentWeek.total > 0
                    ? 100
                    : 0
        const conformityDelta = currentWeek.conformity - previousWeek.conformity

        const oldestPendingDays = pendingRooms.length
            ? Math.max(...pendingRooms.map((room) => room.daysPending))
            : 0

        const topRiskUh = [...uhRiskMap.entries()]
            .sort((a, b) => b[1].pendentes - a[1].pendentes || b[1].total - a[1].total)
            .at(0)

        const priorityRooms = pendingRooms
            .sort((a, b) => b.daysPending - a.daysPending || a.uh.localeCompare(b.uh))
            .slice(0, 4)

        const activeDays = new Set(currentMonthRecords.map((record) => record.date)).size
        const averagePerDay = activeDays > 0 ? currentMonthRecords.length / activeDays : 0
        const executionRate = monthStats.retrabalho > 0 ? Math.round((monthStats.retrabalhoExecutado / monthStats.retrabalho) * 100) : 100
        const targetReached = monthStats.conformidadePercentual >= targetConformity
        const operationalScore = Math.max(
            0,
            Math.min(
                100,
                Math.round(monthStats.conformidadePercentual - monthStats.retrabalhoPendente * 3 + monthStats.retrabalhoExecutado * 2),
            ),
        )

        const pendingPressure =
            monthStats.retrabalhoPendente >= 7 || oldestPendingDays >= 4
                ? 'Atenção alta'
                : monthStats.retrabalhoPendente >= 3 || oldestPendingDays >= 2
                    ? 'Atenção moderada'
                    : 'Situação estável'

        return {
            trend,
            maxTotal,
            oldestPendingDays,
            topRiskUh,
            priorityRooms,
            averagePerDay,
            executionRate,
            targetConformity,
            targetReached,
            volumeDeltaPercent,
            conformityDelta,
            pendingPressure,
            operationalScore,
        }
    }, [currentMonthRecords, monthStats])

    const userDisplayName = useMemo(() => getUserDisplayName(loggedUserEmail), [loggedUserEmail])
    const userInitials = useMemo(() => getUserInitials(loggedUserEmail), [loggedUserEmail])

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setIsPageLoading(false)
        }, 520)

        return () => window.clearTimeout(timer)
    }, [])

    useEffect(() => {
        if (rooms.length > 0) {
            setUh(rooms[0])
            setEditUh(rooms[0])
        }
    }, [rooms])

    useEffect(() => {
        if (!auth) {
            setIsAuthLoading(false)
            setIsLoggedIn(false)
            return
        }

        const unsubscribe = onAuthStateChanged(auth, (user) => {
            setCurrentUser(user)
            setIsLoggedIn(Boolean(user))
            setLoggedUserEmail(user?.email ?? '')
            setIsAuthLoading(false)
        })

        return () => unsubscribe()
    }, [])

    useEffect(() => {
        if (!db) {
            setIsRecordsLoading(false)
            return
        }

        if (!currentUser) {
            if (!isAuthLoading) {
                setRecords([])
            }
            return
        }

        setIsRecordsLoading(true)
        const recordsQuery = query(collection(db, 'inspections'), where('ownerId', '==', currentUser.uid))

        const unsubscribe = onSnapshot(
            recordsQuery,
            (snapshot) => {
                const nextRecords: InspectionRecord[] = []

                snapshot.docs.forEach((snapshotDoc) => {
                    const data = snapshotDoc.data() as Partial<InspectionRecord>

                    if (
                        typeof data.id !== 'number' ||
                        typeof data.uh !== 'string' ||
                        !isInspectionStatus(data.status) ||
                        typeof data.date !== 'string' ||
                        typeof data.time !== 'string'
                    ) {
                        return
                    }

                    nextRecords.push({
                        id: data.id,
                        firestoreId: snapshotDoc.id,
                        ownerId: data.ownerId,
                        createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
                        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
                        createdByEmail: typeof data.createdByEmail === 'string' ? data.createdByEmail : undefined,
                        updatedByEmail: typeof data.updatedByEmail === 'string' ? data.updatedByEmail : undefined,
                        reworkDone: typeof data.reworkDone === 'boolean' ? data.reworkDone : false,
                        reworkCompletedAt: typeof data.reworkCompletedAt === 'string' ? data.reworkCompletedAt : undefined,
                        reworkCompletedByEmail: typeof data.reworkCompletedByEmail === 'string' ? data.reworkCompletedByEmail : undefined,
                        hotel: typeof data.hotel === 'string' ? data.hotel : 'praia',
                        housekeeper: typeof data.housekeeper === 'string' ? data.housekeeper : '',
                        inspector: typeof data.inspector === 'string' ? data.inspector : '',
                        uh: data.uh,
                        status: data.status,
                        date: data.date,
                        month: typeof data.month === 'string' ? data.month : getMonthFromDate(data.date),
                        time: data.time,
                        note: typeof data.note === 'string' ? data.note : '',
                    })
                })

                nextRecords.sort((a, b) => b.id - a.id)

                setRecords(nextRecords)
                localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRecords))
                setIsRecordsLoading(false)
            },
            (error) => {
                pushNotification(getFirebaseErrorMessage(error, 'Falha ao carregar dados do Firebase.'), 'aviso')
                setIsRecordsLoading(false)
            },
        )

        return () => unsubscribe()
    }, [currentUser, isAuthLoading])

    useEffect(() => {
        if (!isLoggedIn) {
            setIsLoginTransition(false)
            return
        }

        if (!isRecordsLoading) {
            const timer = window.setTimeout(() => {
                setIsLoginTransition(false)
            }, 820)

            return () => window.clearTimeout(timer)
        }
    }, [isLoggedIn, isRecordsLoading])

    useEffect(() => {
        if (!isSidebarOpen) {
            return
        }

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target
            if (!(target instanceof Node)) {
                return
            }

            if (menuTriggerRef.current?.contains(target) || quickSidebarRef.current?.contains(target)) {
                return
            }

            setIsSidebarOpen(false)
        }

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsSidebarOpen(false)
            }
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleEscape)

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleEscape)
        }
    }, [isSidebarOpen])

    useEffect(() => {
        if (!isDatePickerOpen) {
            return
        }

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target
            if (!(target instanceof Node)) {
                return
            }

            if (datePickerRef.current?.contains(target)) {
                return
            }

            setIsDatePickerOpen(false)
        }

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsDatePickerOpen(false)
            }
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleEscape)

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleEscape)
        }
    }, [isDatePickerOpen])

    useEffect(() => {
        const interval = window.setInterval(() => {
            setCurrentMonthKey(getNowValues().month)
        }, 60 * 60 * 1000)

        return () => window.clearInterval(interval)
    }, [])


    const pushNotification = (message: string, type: NoticeType = 'info') => {
        const id = Date.now() + Math.floor(Math.random() * 1000)
        setNotifications((current) => [...current, { id, message, type }])

        window.setTimeout(() => {
            setNotifications((current) => current.filter((item) => item.id !== id))
        }, 3300)
    }

    const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()

        if (!auth) {
            setAuthError('Configuração do Firebase ausente. Defina os secrets do GitHub Pages.')
            return
        }

        const normalizedEmail = loginEmail.trim().toLowerCase()
        const trimmedPassword = loginPassword.trim()

        if (!normalizedEmail || !trimmedPassword) {
            setAuthError('Preencha e-mail e senha para entrar.')
            return
        }

        setAuthError('')
        setIsLoginTransition(true)
        setIsAuthenticating(true)

        try {
            await signInWithEmailAndPassword(auth, normalizedEmail, trimmedPassword)
            setLoginPassword('')
        } catch (error) {
            setAuthError(getFirebaseErrorMessage(error, 'Credenciais inválidas. Verifique seu usuário no Firebase Auth.'))
            setIsLoginTransition(false)
        } finally {
            setIsAuthenticating(false)
        }
    }

    const handleLogout = () => {
        if (!auth) {
            return
        }

        setIsLoginTransition(false)

        signOut(auth)
            .then(() => {
                setLoginEmail('')
                setLoginPassword('')
                setAuthError('')
            setSelectedHotel(null)
            })
            .catch(() => {
                pushNotification('Não foi possível encerrar a sessão.', 'aviso')
            })
    }

    const handleResetPassword = async () => {
        const normalizedEmail = loginEmail.trim().toLowerCase()
        if (!normalizedEmail) {
            setAuthError('Informe seu e-mail para recuperar a senha.')
            return
        }

        try {
            if (!db) {
                setAuthError('Configuração do Firebase ausente. Não foi possível registrar a solicitação de recuperação.')
                return
            }

            await addDoc(collection(db, 'passwordRecoveryRequests'), {
                email: normalizedEmail,
                destinationEmail: RECOVERY_NOTIFICATION_EMAIL || null,
                requestedAt: new Date().toISOString(),
                status: 'solicitado',
                origin: 'login',
            })

            if (auth) {
                await sendPasswordResetEmail(auth, normalizedEmail).catch(() => undefined)
            }

            setAuthError('Solicitação de recuperação de senha foi solicitada. Em algum tempo haverá retorno.')
        } catch (error) {
            setAuthError(getFirebaseErrorMessage(error, 'Não foi possível registrar a recuperação de senha para retorno da governança.'))
        }
    }

    const handleDateChange = (value: string) => {
        setDate(value)
    }

    const handleEditDateChange = (value: string) => {
        setEditDate(value)
    }

    const handleRegister = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()

        if (!db) {
            pushNotification('Firebase não configurado para este ambiente.', 'aviso')
            return
        }

        if (!uh || !housekeeper.trim() || !inspector.trim() || !date || !time) {
            pushNotification('Preencha UH, camareira, inspetor, data e hora para salvar.', 'aviso')
            return
        }

        if (!currentUser) {
            pushNotification('Faça login novamente para registrar inspeções.', 'aviso')
            return
        }

        setIsSavingNewRecord(true)

        const newRecord: InspectionRecord = {
            id: Date.now(),
            ownerId: currentUser.uid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            createdByEmail: currentUser.email ?? '',
            updatedByEmail: currentUser.email ?? '',
            reworkDone: false,
            housekeeper: housekeeper.trim(),
            hotel: selectedHotel ?? 'praia',
            inspector: inspector.trim(),
            uh,
            status,
            date,
            month: getMonthFromDate(date),
            time,
            note: note.trim(),
        }

        try {
            await addDoc(collection(db, 'inspections'), newRecord)
            setStatus('Conforme')
            setHousekeeper('')
            setInspector('')
            setNote('')
            pushNotification('Inspeção registrada com sucesso.', 'sucesso')
        } catch (error) {
            pushNotification(getFirebaseErrorMessage(error, 'Falha ao salvar no Firebase. Tente novamente.'), 'aviso')
        } finally {
            setIsSavingNewRecord(false)
        }
    }

    const handleEditRecord = (record: InspectionRecord) => {
        setEditModalOpen(true)
        setEditingRecordId(record.id)
        setEditRecordAudit(record)
        setEditUh(record.uh)
        setEditHousekeeper(record.housekeeper)
        setEditInspector(record.inspector)
        setEditStatus(record.status)
        setEditReworkDone(Boolean(record.reworkDone))
        setEditDate(record.date)
        setEditTime(record.time)
        setEditNote(record.note)
    }

    const closeEditModal = () => {
        setEditModalOpen(false)
        setEditingRecordId(null)
        setEditRecordAudit(null)
        setEditReworkDone(false)
    }

    const handleEditSave = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()

        if (!db) {
            pushNotification('Firebase não configurado para este ambiente.', 'aviso')
            return
        }

        if (!editingRecordId) {
            return
        }

        if (!editUh || !editHousekeeper.trim() || !editInspector.trim() || !editDate || !editTime) {
            pushNotification('Preencha UH, camareira, inspetor, data e hora para atualizar.', 'aviso')
            return
        }

        const recordToUpdate = records.find((record) => record.id === editingRecordId)
        if (!recordToUpdate?.firestoreId) {
            pushNotification('Registro não encontrado para atualização.', 'aviso')
            return
        }

        setIsSavingEdit(true)

        try {
            const nowIso = new Date().toISOString()
            const nextReworkDone = editStatus === 'Retrabalho' ? editReworkDone : false
            const nextReworkCompletedAt =
                editStatus === 'Retrabalho' && editReworkDone
                    ? recordToUpdate.reworkDone
                        ? recordToUpdate.reworkCompletedAt ?? nowIso
                        : nowIso
                    : null
            const nextReworkCompletedByEmail =
                editStatus === 'Retrabalho' && editReworkDone
                    ? recordToUpdate.reworkDone
                        ? recordToUpdate.reworkCompletedByEmail ?? currentUser?.email ?? ''
                        : currentUser?.email ?? ''
                    : ''

            await updateDoc(doc(db, 'inspections', recordToUpdate.firestoreId), {
                uh: editUh,
                housekeeper: editHousekeeper.trim(),
                inspector: editInspector.trim(),
                status: editStatus,
                reworkDone: nextReworkDone,
                reworkCompletedAt: nextReworkCompletedAt,
                reworkCompletedByEmail: nextReworkCompletedByEmail,
                date: editDate,
                month: getMonthFromDate(editDate),
                time: editTime,
                note: editNote.trim(),
                updatedAt: new Date().toISOString(),
                updatedByEmail: currentUser?.email ?? '',
            })

            closeEditModal()
            pushNotification('Registro atualizado com sucesso.', 'sucesso')
        } catch (error) {
            pushNotification(getFirebaseErrorMessage(error, 'Não foi possível atualizar no Firebase.'), 'aviso')
        } finally {
            setIsSavingEdit(false)
        }
    }

    const handleMarkReworkDone = async (record: InspectionRecord) => {
        if (!db || !record.firestoreId) {
            pushNotification('Registro de retrabalho sem referência para atualização.', 'aviso')
            return
        }

        try {
            await updateDoc(doc(db, 'inspections', record.firestoreId), {
                reworkDone: true,
                reworkCompletedAt: new Date().toISOString(),
                reworkCompletedByEmail: currentUser?.email ?? '',
                updatedAt: new Date().toISOString(),
                updatedByEmail: currentUser?.email ?? '',
            })

            pushNotification(`UH ${record.uh} marcada como retrabalho executado.`, 'sucesso')
        } catch (error) {
            pushNotification(getFirebaseErrorMessage(error, 'Não foi possível concluir o retrabalho.'), 'aviso')
        }
    }

    const showPendingReworks = () => {
        const nowValues = getNowValues()
        setViewStartDate(`${nowValues.month}-01`)
        setViewEndDate(nowValues.date)
        setViewStatus('Retrabalho')
        setViewReworkExecution('Pendentes')
        setViewSearch('')
        setIsFilterActive(true)
        setActiveViewPreset(null)
        setWorkspaceView('inspections')
        setInspectionSection('report')
    }

    const showAllReworks = () => {
        const nowValues = getNowValues()
        setViewStartDate(`${nowValues.month}-01`)
        setViewEndDate(nowValues.date)
        setViewStatus('Retrabalho')
        setViewReworkExecution('Todos')
        setViewSearch('')
        setIsFilterActive(true)
        setActiveViewPreset(null)
        setWorkspaceView('inspections')
        setInspectionSection('report')
    }

    const requestDeleteRecord = (recordId?: string) => {
        if (!recordId) {
            pushNotification('Registro sem referência no Firebase.', 'aviso')
            return
        }

        setConfirmDialog({
            isOpen: true,
            action: 'excluir',
            recordId,
        })
    }


    const closeConfirmDialog = () => {
        setClearRecordsPassword('')
        setClearRecordsError('')
        setIsConfirmingClear(false)
        setConfirmDialog({ isOpen: false, action: 'excluir' })
    }

    const handleConfirmDialog = async () => {
        if (!db) {
            pushNotification('Firebase não configurado para este ambiente.', 'aviso')
            closeConfirmDialog()
            return
        }

        const firestore = db

        if (confirmDialog.action === 'excluir' && confirmDialog.recordId) {
            try {
                await deleteDoc(doc(firestore, 'inspections', confirmDialog.recordId))

                const deletedRecord = records.find((record) => record.firestoreId === confirmDialog.recordId)
                if (deletedRecord && editingRecordId === deletedRecord.id) {
                    closeEditModal()
                }

                pushNotification('Registro excluído.', 'sucesso')
            } catch (error) {
                pushNotification(getFirebaseErrorMessage(error, 'Não foi possível excluir o registro.'), 'aviso')
            }

            closeConfirmDialog()
            return
        }

        if (confirmDialog.action === 'limpar') {
            if (!auth || !currentUser?.email) {
                setClearRecordsError('Sessão inválida. Faça login novamente para continuar.')
                return
            }

            const trimmedPassword = clearRecordsPassword.trim()
            if (!trimmedPassword) {
                setClearRecordsError('Informe sua senha para confirmar a limpeza.')
                return
            }

            try {
                setIsConfirmingClear(true)
                setClearRecordsError('')

                const credential = EmailAuthProvider.credential(currentUser.email, trimmedPassword)
                await reauthenticateWithCredential(currentUser, credential)

                const batch = writeBatch(firestore)
                filteredRecords.forEach((record) => {
                    if (record.firestoreId) {
                        batch.delete(doc(firestore, 'inspections', record.firestoreId))
                    }
                })
                await batch.commit()
                pushNotification('Todos os registros foram removidos.', 'info')
            } catch (error) {
                const message = getFirebaseErrorMessage(error, 'Não foi possível validar sua senha para limpar os registros.')
                setClearRecordsError(message)
                setIsConfirmingClear(false)
                return
            }

            closeConfirmDialog()
            return
        }
    }

    const clearViewFilters = () => {
        setViewStartDate(initialNow.date)
        setViewEndDate(initialNow.date)
        setViewStatus('Todos')
        setViewReworkExecution('Todos')
        setViewSearch('')
        setIsFilterActive(false)
        setActiveViewPreset(null)
        setTempStartDate(null)
    }

    const applyViewPreset = (preset: 'today' | 'week' | 'month') => {
        const now = new Date()
        const endDate = now.toISOString().slice(0, 10)

        if (preset === 'today') {
            setViewStartDate(endDate)
            setViewEndDate(endDate)
            setTempStartDate(endDate)
            setIsFilterActive(true)
            setActiveViewPreset('today')
            setIsDatePickerOpen(false)
            return
        }

        if (preset === 'week') {
            const start = new Date(now)
            start.setDate(start.getDate() - 6)
            const startStr = start.toISOString().slice(0, 10)
            setViewStartDate(startStr)
            setViewEndDate(endDate)
            setTempStartDate(startStr)
            setIsFilterActive(true)
            setActiveViewPreset('week')
            setIsDatePickerOpen(false)
            return
        }

        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
        const startStr = startOfMonth.toISOString().slice(0, 10)
        setViewStartDate(startStr)
        setViewEndDate(endDate)
        setTempStartDate(startStr)
        setIsFilterActive(true)
        setActiveViewPreset('month')
        setIsDatePickerOpen(false)
    }

    const handlePrevMonth = () => {
        setCalendarMonth((prev) => {
            const next = new Date(prev)
            next.setMonth(prev.getMonth() - 1)
            return next
        })
    }

    const handleNextMonth = () => {
        setCalendarMonth((prev) => {
            const next = new Date(prev)
            next.setMonth(prev.getMonth() + 1)
            return next
        })
    }

    const calendarMonthLabel = useMemo(() => {
        const formatted = new Intl.DateTimeFormat('pt-BR', {
            month: 'long',
            year: 'numeric',
        }).format(calendarMonth)
        return formatted.charAt(0).toUpperCase() + formatted.slice(1)
    }, [calendarMonth])

    const calendarDays = useMemo(() => {
        const year = calendarMonth.getFullYear()
        const month = calendarMonth.getMonth()

        const firstDayOfMonth = new Date(year, month, 1)
        const startDayIndex = firstDayOfMonth.getDay()

        const totalDays = new Date(year, month + 1, 0).getDate()

        const prevMonthDaysCount = startDayIndex
        const prevMonthYear = month === 0 ? year - 1 : year
        const prevMonth = month === 0 ? 11 : month - 1
        const totalDaysPrevMonth = new Date(prevMonthYear, prevMonth + 1, 0).getDate()

        const days: Array<{ dateStr: string; dayNum: number; isCurrentMonth: boolean }> = []

        for (let i = prevMonthDaysCount - 1; i >= 0; i--) {
            const dayNum = totalDaysPrevMonth - i
            const monthStr = (prevMonth + 1).toString().padStart(2, '0')
            const dayStr = dayNum.toString().padStart(2, '0')
            days.push({
                dateStr: `${prevMonthYear}-${monthStr}-${dayStr}`,
                dayNum,
                isCurrentMonth: false,
            })
        }

        for (let i = 1; i <= totalDays; i++) {
            const monthStr = (month + 1).toString().padStart(2, '0')
            const dayStr = i.toString().padStart(2, '0')
            days.push({
                dateStr: `${year}-${monthStr}-${dayStr}`,
                dayNum: i,
                isCurrentMonth: true,
            })
        }

        const totalCells = 42
        const nextMonthYear = month === 11 ? year + 1 : year
        const nextMonth = month === 11 ? 0 : month + 1
        const remainingCells = totalCells - days.length
        for (let i = 1; i <= remainingCells; i++) {
            const monthStr = (nextMonth + 1).toString().padStart(2, '0')
            const dayStr = i.toString().padStart(2, '0')
            days.push({
                dateStr: `${nextMonthYear}-${monthStr}-${dayStr}`,
                dayNum: i,
                isCurrentMonth: false,
            })
        }

        return days
    }, [calendarMonth])

    const handleCalendarDayClick = (dateStr: string) => {
        if (!tempStartDate || (tempStartDate && viewEndDate)) {
            setTempStartDate(dateStr)
            setViewStartDate(dateStr)
            setViewEndDate('')
            setIsFilterActive(true)
            setActiveViewPreset(null)
        } else {
            if (dateStr >= tempStartDate) {
                setViewEndDate(dateStr)
                setIsFilterActive(true)
                setActiveViewPreset(null)
                setIsDatePickerOpen(false)
            } else {
                setTempStartDate(dateStr)
                setViewStartDate(dateStr)
            }
        }
    }

    const formattedDateRange = useMemo(() => {
        const start = formatDateBR(viewStartDate)
        if (!viewEndDate || viewStartDate === viewEndDate) {
            return start
        }
        const end = formatDateBR(viewEndDate)
        return `${start} - ${end}`
    }, [viewStartDate, viewEndDate])

    const navigateToOverview = () => {
        setWorkspaceView('overview')
        setIsSidebarOpen(false)
    }

    const openInspectionMenu = () => {
        setWorkspaceView('inspections')
    }

    const navigateToInspectionReport = () => {
        setWorkspaceView('inspections')
        setInspectionSection('report')
        setIsSidebarOpen(false)
    }

    const navigateToInspectionRegister = () => {
        setWorkspaceView('inspections')
        setInspectionSection('register')
        setIsSidebarOpen(false)
    }

    const goToCurrentMonthReport = (pendingOnly: boolean) => {
        const nowValues = getNowValues()
        const monthStartDate = `${nowValues.month}-01`

        setWorkspaceView('inspections')
        setInspectionSection('report')
        setViewStartDate(monthStartDate)
        setViewEndDate(nowValues.date)
        setViewSearch('')
        setViewStatus(pendingOnly ? 'Retrabalho' : 'Todos')
        setViewReworkExecution(pendingOnly ? 'Pendentes' : 'Todos')
        setIsFilterActive(true)
        setActiveViewPreset(null)
        setIsSidebarOpen(false)
    }


    const navigateToPriorityUh = (uhCode: string) => {
        const nowValues = getNowValues()

        setWorkspaceView('inspections')
        setInspectionSection('report')
        setViewStartDate(`${nowValues.month}-01`)
        setViewEndDate(nowValues.date)
        setViewStatus('Retrabalho')
        setViewReworkExecution('Pendentes')
        setViewSearch(uhCode)
        setIsFilterActive(true)
        setActiveViewPreset(null)
        setIsSidebarOpen(false)
    }

    const exportConformes = viewedRecords.filter((record) => record.status === 'Conforme').length
    const exportRetrabalho = viewedRecords.length - exportConformes
    const exportRetrabalhoPendente = viewedRecords.filter((record) => isReworkPending(record)).length

    const exportRows = viewedRecords.map((item) => ({
        Unidade: item.hotel === 'express' ? 'Pajuçara Express' : 'Pajuçara Praia Hotel',
        UH: item.uh,
        Camareira: item.housekeeper,
        Inspetor: item.inspector,
        Status: item.status,
        'Execução do retrabalho': item.status !== 'Retrabalho' ? '-' : item.reworkDone ? 'Executado' : 'Pendente',
        Data: formatDateBR(item.date),
        Hora: item.time,
        Observacao: item.note,
    }))

    const handleExportCsv = () => {
        if (!exportRows.length) {
            pushNotification('Não há registros nos filtros atuais para exportar.', 'aviso')
            return
        }

        const headers = Object.keys(exportRows[0])
        const escapeCsv = (value: string) => `"${value.replaceAll('"', '""')}"`
        const lines = [
            headers.join(';'),
            ...exportRows.map((row) =>
                headers
                    .map((header) => escapeCsv(String(row[header as keyof typeof row] ?? '')))
                    .join(';'),
            ),
        ]

        const bom = '\uFEFF'
        downloadBlob(bom + lines.join('\n'), 'relatorio-inspecoes.csv', 'text/csv;charset=utf-8;')
        pushNotification('Arquivo CSV exportado com sucesso.', 'sucesso')
    }

    const handleExportExcel = async () => {
        if (!exportRows.length) {
            pushNotification('Não há registros nos filtros atuais para exportar.', 'aviso')
            return
        }

        try {
            const XLSX = await import('xlsx')
            const worksheet = XLSX.utils.json_to_sheet(exportRows)

            worksheet['!cols'] = [
                { wch: 26 },
                { wch: 8 },
                { wch: 22 },
                { wch: 22 },
                { wch: 14 },
                { wch: 22 },
                { wch: 14 },
                { wch: 8 },
                { wch: 36 },
            ]

            const headerRange = XLSX.utils.decode_range(worksheet['!ref'] ?? 'A1')
            for (let col = headerRange.s.c; col <= headerRange.e.c; col++) {
                const cellRef = XLSX.utils.encode_cell({ r: 0, c: col })
                const cell = worksheet[cellRef]
                if (cell) {
                    cell.s = {
                        font: { bold: true, color: { rgb: 'FFFFFF' } },
                        fill: { fgColor: { rgb: '1B4F5C' } },
                        alignment: { horizontal: 'center' },
                        border: {
                            bottom: { style: 'thin', color: { rgb: '0D3640' } },
                        },
                    }
                }
            }

            for (let row = 1; row <= headerRange.e.r; row++) {
                for (let col = headerRange.s.c; col <= headerRange.e.c; col++) {
                    const cellRef = XLSX.utils.encode_cell({ r: row, c: col })
                    const cell = worksheet[cellRef]
                    if (cell) {
                        cell.s = {
                            alignment: { horizontal: 'center' },
                            border: {
                                bottom: { style: 'thin', color: { rgb: 'D0DDD9' } },
                            },
                        }
                    }
                }
            }

            const workbook = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Inspeções')
            XLSX.writeFile(workbook, 'relatorio-inspecoes.xlsx', { bookSST: true })
            pushNotification('Arquivo Excel exportado com sucesso.', 'sucesso')
        } catch {
            pushNotification('Não foi possível gerar o Excel neste momento.', 'aviso')
        }
    }

    const confirmDialogTitle =
        confirmDialog.action === 'limpar' ? 'Limpar registros' : 'Excluir registro'

    const confirmDialogMessage =
        confirmDialog.action === 'limpar'
            ? 'Deseja realmente apagar todos os registros? Essa ação não pode ser desfeita.'
            : 'Deseja realmente excluir este registro de inspeção?'

    if (isLoginTransition) {
        return (
            <div className="app-shell">
                <div className="login-transition" aria-live="polite">
                    <div className="login-transition-content">
                        <div className="login-transition-rings" aria-hidden="true">
                            <span className="ring ring-one" />
                            <span className="ring ring-two" />
                            <span className="ring ring-three" />
                        </div>
                        <h2>Preparando seu ambiente</h2>
                        <p>Validando credenciais e carregando painel de governança...</p>
                    </div>
                </div>
            </div>
        )
    }

    if (isPageLoading || isAuthLoading || (isLoggedIn && isRecordsLoading)) {
        return (
            <div className="app-shell">
                <div className="loading-panel" aria-live="polite">
                    <div className="loading-content">
                        <div className="loading-spinner-large" />
                        <h2>InspeGov</h2>
                        <p>{isPageLoading || isAuthLoading ? 'Validando acesso seguro...' : 'Carregando seus registros...'}</p>
                    </div>
                </div>
            </div>
        )
    }

    if (!firebaseReady) {
        return (
            <div className="app-shell">
                <div className="loading-panel" aria-live="polite">
                    <div className="loading-content">
                        <h2>Configuração pendente</h2>
                        <p>Defina as variáveis VITE_FIREBASE_* no ambiente do GitHub Pages.</p>
                    </div>
                </div>
            </div>
        )
    }

    if (!isLoggedIn) {
        return (
            <div className="login-shell">

                <div className="login-glow login-glow-one" />
                <div className="login-glow login-glow-two" />

                <div className="login-theme-toggle-container">
                    <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label="Alternar tema">
                        {theme === 'light' ? (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                        ) : (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                        )}
                    </button>
                </div>

                <div className="login-layout zoom-in">
                    <section className="login-showcase">
                        <div className="login-showcase-mark">
                            <span className="login-showcase-badge">InspeGov</span>
                            <span className="login-showcase-dot" aria-hidden="true" />
                        </div>
                        <div className="login-showcase-copy">
                            <p className="kicker login-kicker">Governança operacional</p>
                            <h1>Controle de inspeções com uma experiência mais executiva.</h1>
                            <p className="login-subtitle">
                                Acompanhe conformidade, registre ocorrências e mantenha rastreabilidade com um painel pensado para rotinas de governança.
                            </p>
                        </div>
                        <div className="login-showcase-visual" aria-hidden="true">
                            <img src={`${import.meta.env.BASE_URL}hotel-login-hero.svg`} alt="" />
                        </div>
                        <div className="login-showcase-metrics" aria-hidden="true">
                            <article className="login-metric-card">
                                <strong>Monitoramento</strong>
                                <span>Status e histórico em uma única visão.</span>
                            </article>
                            <article className="login-metric-card">
                                <strong>Rastreabilidade</strong>
                                <span>Registros auditáveis para operação e gestão.</span>
                            </article>
                        </div>
                    </section>

                    <form className="login-card" onSubmit={handleLogin}>
                        <div className="login-card-header">
                            <p className="kicker login-kicker">Acesso seguro</p>
                            <h2>Entrar no sistema</h2>
                            <p className="login-card-subtitle">Use suas credenciais corporativas para acessar o painel de inspeções.</p>
                        </div>

                        <label>
                            E-mail corporativo
                            <input
                                type="email"
                                value={loginEmail}
                                onChange={(event) => setLoginEmail(event.target.value)}
                                placeholder="ex.: supervisor@inspegov.com"
                                autoComplete="username"
                                required
                            />
                        </label>

                        <label>
                            Senha
                            <input
                                type="password"
                                value={loginPassword}
                                onChange={(event) => setLoginPassword(event.target.value)}
                                placeholder="Digite sua senha"
                                autoComplete="current-password"
                                required
                            />
                        </label>

                        {authError ? <p className="login-error">{authError}</p> : null}

                        <button type="submit" className="save-btn login-btn" disabled={isAuthenticating}>
                            {isAuthenticating ? (
                                <>
                                    <span className="inline-spinner" aria-hidden="true" />
                                    Autenticando...
                                </>
                            ) : (
                                'Entrar no sistema'
                            )}
                        </button>

                        <button type="button" className="ghost-btn login-reset-btn" onClick={handleResetPassword}>
                            Redefinir senha
                        </button>
                    </form>
                </div>
            </div>
        )
    }

    if (!selectedHotel) {
        return (
            <div className="hotel-picker-shell">
                <div className="hotel-picker-glow hotel-picker-glow-one" />
                <div className="hotel-picker-glow hotel-picker-glow-two" />

                <div className="picker-theme-toggle-container">
                    <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label="Alternar tema">
                        {theme === 'light' ? (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                        ) : (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                        )}
                    </button>
                </div>

                <div className="hotel-picker-layout zoom-in">
                    <div className="hotel-picker-header">
                        <p className="kicker">InspeGov</p>
                        <h1>Selecione a unidade</h1>
                        <p className="hotel-picker-subtitle">
                            Bem-vindo, <strong>{userDisplayName}</strong>. Escolha a unidade que deseja gerenciar.
                        </p>
                    </div>

                    <div className="hotel-picker-cards">
                        <button
                            type="button"
                            className="hotel-card"
                            onClick={() => setSelectedHotel('praia')}
                        >
                            <span className="hotel-card-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M3 21H21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                                    <path d="M5 21V7L12 3L19 7V21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                                    <path d="M9 21V15H15V21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                                    <path d="M9 11H10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                                    <path d="M14 11H15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                                </svg>
                            </span>
                            <strong className="hotel-card-name">Pajuçara Praia Hotel</strong>
                            <span className="hotel-card-desc">Unidade completa · Andares 1 a 9</span>
                            <span className="hotel-card-arrow" aria-hidden="true">→</span>
                        </button>

                        <button
                            type="button"
                            className="hotel-card"
                            onClick={() => setSelectedHotel('express')}
                        >
                            <span className="hotel-card-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
                                    <path d="M3 9H21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                                    <path d="M9 9V21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                                    <path d="M13 13H17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                                    <path d="M13 17H17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                                </svg>
                            </span>
                            <strong className="hotel-card-name">Pajuçara Express</strong>
                            <span className="hotel-card-desc">Unidade express · Andares 1 a 7</span>
                            <span className="hotel-card-arrow" aria-hidden="true">→</span>
                        </button>
                    </div>

                    <button type="button" className="ghost-btn hotel-picker-logout" onClick={handleLogout}>
                        Sair da conta
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div className={`app-shell ${isSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
            <div className="notifications" aria-live="polite">
                {notifications.map((notification) => (
                    <article key={notification.id} className={`notice notice-${notification.type}`}>
                        {notification.message}
                    </article>
                ))}
            </div>

            <header
                className="topbar"
                role="button"
                tabIndex={0}
                onClick={scrollToTop}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        scrollToTop()
                    }
                }}
            >
                <div>
                    <p className="kicker">InspeGov</p>
                    <h1>Gestão de Governança</h1>
                    <p className="subtitle">
                        {selectedHotel === 'express' ? 'Pajuçara Express' : 'Pajuçara Praia Hotel'}
                    </p>
                </div>
                <div className="topbar-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                    <div className="user-profile">
                        <div className="avatar">{userInitials}</div>
                        <div className="user-info">
                            <strong>{userDisplayName}</strong>
                            <span>{loggedUserEmail || 'Unidade Central'}</span>
                        </div>
                        <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label="Alternar tema">
                            {theme === 'light' ? (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                            ) : (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                            )}
                        </button>
                    </div>
                </div>
            </header>

            <nav className="menu-trigger-row" aria-label="Menu rápido">
                <button
                    ref={menuTriggerRef}
                    type="button"
                    className={`menu-trigger-button ${isSidebarOpen ? 'active' : ''}`}
                    onClick={() => setIsSidebarOpen((current) => !current)}
                    aria-expanded={isSidebarOpen}
                    aria-controls="quick-sidebar"
                    aria-label="Abrir atalhos operacionais"
                >
                    <span className="menu-lines" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                    </span>
                    <span>Operações</span>
                </button>
            </nav>

            {isSidebarOpen ? (
                <div className="sidebar-backdrop" onClick={() => setIsSidebarOpen(false)} aria-hidden="true" />
            ) : null}

            <aside
                ref={quickSidebarRef}
                id="quick-sidebar"
                className={`quick-sidebar ${isSidebarOpen ? 'open' : ''}`}
                aria-hidden={!isSidebarOpen}
            >
                <div className="quick-sidebar-inner">
                    <div className="sidebar-brand-row">
                        <span className="sidebar-brand-logo">InspeGov</span>
                        <button
                            type="button"
                            className="sidebar-collapse-btn-desktop"
                            onClick={toggleSidebarCollapsed}
                            aria-label={isSidebarCollapsed ? "Expandir menu" : "Recuar menu"}
                        >
                            {isSidebarCollapsed ? (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                            ) : (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                            )}
                        </button>
                    </div>
                    <button 
                        type="button" 
                        className="sidebar-close-btn" 
                        onClick={() => setIsSidebarOpen(false)}
                        aria-label="Fechar menu"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                    <button
                        type="button"
                        className={workspaceView === 'overview' ? 'quick-link active' : 'quick-link'}
                        onClick={navigateToOverview}
                    >
                        <span className="quick-link-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M4 19.5H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M7 16V10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M12 16V6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M17 16V12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                            </svg>
                        </span>
                        <span>Visão geral</span>
                    </button>

                    <button
                        type="button"
                        className={workspaceView === 'inspections' ? 'quick-link active' : 'quick-link'}
                        onClick={openInspectionMenu}
                    >
                        <span className="quick-link-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M7 4.5H14L18.5 9V19.5H7V4.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                <path d="M14 4.5V9H18.5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                <path d="M9.5 12H15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M9.5 15H15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                            </svg>
                        </span>
                        <span>Inspeções</span>
                    </button>

                    {workspaceView === 'inspections' ? (
                        <div className="quick-submenu">
                            <button
                                type="button"
                                className={inspectionSection === 'report' ? 'quick-sublink active' : 'quick-sublink'}
                                onClick={navigateToInspectionReport}
                            >
                                <span className="quick-link-icon" aria-hidden="true">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M5 19.5H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                        <path d="M8 16V11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                        <path d="M12 16V8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                        <path d="M16 16V13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                    </svg>
                                </span>
                                <span>Relatório de Inspeções</span>
                            </button>
                            <button
                                type="button"
                                className={inspectionSection === 'register' ? 'quick-sublink active' : 'quick-sublink'}
                                onClick={navigateToInspectionRegister}
                            >
                                <span className="quick-link-icon" aria-hidden="true">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M12 5V19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                        <path d="M5 12H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                    </svg>
                                </span>
                                <span>Registrar inspeção</span>
                            </button>
                        </div>
                    ) : null}

                    <div className="sidebar-footer-profile">
                        <div className="user-profile-sidebar">
                            <div className="avatar">{userInitials}</div>
                            <div className="user-info-sidebar">
                                <strong>{userDisplayName}</strong>
                                <span>{loggedUserEmail || 'Unidade Central'}</span>
                            </div>
                        </div>
                        <div className="sidebar-actions-row">
                            <button type="button" className="sidebar-switch-btn" onClick={() => setSelectedHotel(null)}>Trocar unidade</button>
                            <button type="button" className="sidebar-logout-btn" onClick={handleLogout}>Sair da conta</button>
                        </div>
                    </div>
                </div>
            </aside>

            <main className={`content-grid ${workspaceView === 'overview' ? 'view-overview' : inspectionSection === 'report' ? 'view-inspections-report' : 'view-inspections-register'}`}>
                {workspaceView === 'overview' ? (
                    <>
                <section className="executive-dashboard">
                    <article className="executive-hero-card">
                        <p className="kicker">Radar Executivo</p>
                        <h2>Painel do mês</h2>
                        <p className="month-highlight">{currentMonthLabel}</p>

                        <div className="executive-score-block" role="status" aria-live="polite">
                            <div className="executive-score-top">
                                <span>Score operacional</span>
                                <strong>{dashboardAnalytics.operationalScore}%</strong>
                            </div>
                            <div className="executive-score-bar" aria-hidden="true">
                                <span style={{ width: `${dashboardAnalytics.operationalScore}%` }} />
                            </div>
                            <div className="executive-score-foot">
                                <span>Execução: {dashboardAnalytics.executionRate}%</span>
                                <span>Média/dia: {dashboardAnalytics.averagePerDay.toFixed(1)}</span>
                            </div>
                        </div>

                        <div className="executive-kpi-strip" aria-label="Indicadores executivos de desempenho">
                            <article className="executive-kpi-pill">
                                <span>Meta mínima</span>
                                <strong>{dashboardAnalytics.targetConformity}%</strong>
                            </article>

                            <article className={`executive-kpi-pill ${dashboardAnalytics.targetReached ? 'good' : 'warning'}`}>
                                <span>Status da meta</span>
                                <strong>{dashboardAnalytics.targetReached ? 'Atingida' : 'Abaixo da meta'}</strong>
                            </article>

                            <article className="executive-kpi-pill">
                                <span>Variação semanal</span>
                                <strong>{dashboardAnalytics.volumeDeltaPercent >= 0 ? '+' : ''}{dashboardAnalytics.volumeDeltaPercent}%</strong>
                            </article>

                            <article className={`executive-kpi-pill ${dashboardAnalytics.pendingPressure === 'Atenção alta' ? 'danger' : dashboardAnalytics.pendingPressure === 'Atenção moderada' ? 'warning' : 'good'}`}>
                                <span>Atenção</span>
                                <strong>{dashboardAnalytics.pendingPressure}</strong>
                            </article>
                        </div>

                        <div className="executive-actions">
                            <button type="button" className="executive-action-btn" onClick={() => goToCurrentMonthReport(false)}>
                                Ver relatório do mês
                            </button>
                            <button type="button" className="executive-action-btn warning" onClick={() => goToCurrentMonthReport(true)}>
                                Ver só pendências
                            </button>
                        </div>
                    </article>

                    <div className="executive-side-grid">
                        <article className="insight-card trend-card">
                            <div className="insight-head">
                                <h3>Últimos 7 dias</h3>
                                <span>pico: {dashboardAnalytics.maxTotal} inspeções</span>
                            </div>
                            <div className="trend-chart" aria-label="Volume diário das inspeções nos últimos sete dias">
                                {dashboardAnalytics.trend.map((day) => (
                                    <div key={day.date} className="trend-column">
                                        <span
                                            className={`trend-bar ${day.retrabalho > day.conformes ? 'critical' : ''}`}
                                            style={{ height: `${day.height}%` }}
                                            title={`${day.label}: ${day.total} inspeções (${day.retrabalho} retrabalhos)`}
                                        />
                                        <strong>{day.total}</strong>
                                        <small>{day.label}</small>
                                    </div>
                                ))}
                            </div>
                        </article>

                        <article className="insight-card highlights-card">
                            <div className="insight-head">
                                <h3>Leitura rápida</h3>
                                <span>agora</span>
                            </div>
                            <ul>
                                <li>
                                    UH crítica: <strong>{dashboardAnalytics.topRiskUh ? `UH ${dashboardAnalytics.topRiskUh[0]}` : '-'}</strong>
                                </li>
                                <li>
                                    Pendências abertas: <strong>{monthStats.retrabalhoPendente}</strong>
                                </li>
                                <li>
                                    Maior pendência: <strong>{dashboardAnalytics.oldestPendingDays} dia(s)</strong>
                                </li>
                            </ul>
                        </article>
                    </div>

                    <article className="insight-card priority-card">
                        <div className="insight-head">
                            <h3>Prioridades imediatas</h3>
                            <span>retrabalho pendente</span>
                        </div>

                        {!dashboardAnalytics.priorityRooms.length ? (
                            <p className="priority-empty">Nenhuma pendência crítica no período. Excelente execução!</p>
                        ) : (
                            <div className="priority-list" role="list" aria-label="Lista de pendências prioritárias">
                                {dashboardAnalytics.priorityRooms.map((room) => (
                                    <button
                                        key={room.id}
                                        type="button"
                                        className="priority-item"
                                        role="listitem"
                                        onClick={() => navigateToPriorityUh(room.uh)}
                                        title={`Abrir relatório da UH ${room.uh}`}
                                    >
                                        <strong>UH {room.uh}</strong>
                                        <span>{room.housekeeper}</span>
                                        <em>{room.daysPending} dia(s) em aberto</em>
                                    </button>
                                ))}
                            </div>
                        )}
                    </article>
                </section>

                <section className="stats-row">
                    <div className="stat-card">
                        <span className="stat-label">Inspeções Totais</span>
                        <strong className="stat-value">{monthStats.total}</strong>
                        <span className="stat-foot">
                            {currentMonthLabel}
                        </span>
                    </div>
                    <div className="stat-card">
                        <span className="stat-label">Conformidade</span>
                        <strong className="stat-value">{monthStats.conformidadePercentual}%</strong>
                        <div className="progress-bar-container"><div className="progress-fill" style={{ width: `${monthStats.conformidadePercentual}%` }}></div></div>
                        <span className="stat-foot">{monthStats.conformes} conformes</span>
                    </div>
                    <button type="button" className={`stat-card danger interactive ${isFilterActive && viewStatus === 'Retrabalho' && viewReworkExecution === 'Todos' ? 'active' : ''}`} onClick={showAllReworks}>
                        <span className="stat-label">Retrabalhos totais</span>
                        <strong className="stat-value">{monthStats.retrabalho}</strong>
                        <span className="stat-foot">{monthStats.retrabalhoExecutado} exec. | {monthStats.retrabalhoPendente} pend.</span>
                    </button>
                    <button type="button" className={`stat-card warning interactive ${isFilterActive && viewStatus === 'Retrabalho' && viewReworkExecution === 'Pendentes' ? 'active' : ''}`} onClick={showPendingReworks}>
                        <span className="stat-label">Pendências abertas</span>
                        <strong className="stat-value">{monthStats.retrabalhoPendente}</strong>
                        <span className="stat-foot">Clique para listar apenas os pendentes</span>
                    </button>
                </section>
                    </>
                ) : null}

                {workspaceView === 'inspections' && inspectionSection === 'register' ? (
                <section className="panel form-panel">
                    <div className="panel-header">
                        <span className="icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M7 3.75H14.25L18.5 8V20.25H7V3.75Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M14 3.75V8H18.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M9.5 12H15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M9.5 15.5H15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                            </svg>
                        </span>
                        <h2>Registrar Inspeção</h2>
                    </div>
                    <form onSubmit={handleRegister} className="inspection-form">
                        <label>
                            UH
                            <select value={uh} onChange={(event) => setUh(event.target.value)} required>
                                {rooms.map((room) => (
                                    <option key={room} value={room}>
                                        UH {room}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <div className="two-columns">
                            <label>
                                Camareira
                                <input
                                    type="text"
                                    value={housekeeper}
                                    onChange={(event) => setHousekeeper(event.target.value)}
                                    placeholder="Nome da camareira"
                                    required
                                />
                            </label>

                            <label>
                                Inspetor(a)
                                <input
                                    type="text"
                                    value={inspector}
                                    onChange={(event) => setInspector(event.target.value)}
                                    placeholder="Quem inspecionou"
                                    required
                                />
                            </label>
                        </div>

                        <div className="status-group" role="radiogroup" aria-label="Status da inspeção">
                            <button
                                type="button"
                                className={status === 'Conforme' ? 'status-btn active conforme' : 'status-btn conforme'}
                                onClick={() => setStatus('Conforme')}
                            >
                                Conforme
                            </button>
                            <button
                                type="button"
                                className={status === 'Retrabalho' ? 'status-btn active retrabalho' : 'status-btn retrabalho'}
                                onClick={() => setStatus('Retrabalho')}
                            >
                                Retrabalho
                            </button>
                        </div>

                        <div className="three-columns">
                            <label>
                                Data
                                <input
                                    type="date"
                                    value={date}
                                    onChange={(event) => handleDateChange(event.target.value)}
                                    required
                                />
                            </label>

                            <label>
                                Hora
                                <input
                                    type="time"
                                    value={time}
                                    onChange={(event) => setTime(event.target.value)}
                                    required
                                />
                            </label>
                        </div>

                        <label>
                            Observação
                            <textarea
                                value={note}
                                onChange={(event) => setNote(event.target.value)}
                                placeholder="Descreva detalhes ou irregularidades..."
                                rows={3}
                            />
                        </label>

                        <button type="submit" className={isSavingNewRecord ? 'save-btn is-saving' : 'save-btn'}>
                            {isSavingNewRecord ? 'Salvando...' : 'Salvar inspeção'}
                        </button>
                    </form>
                </section>
                ) : null}

                {workspaceView === 'inspections' && inspectionSection === 'report' ? (
                <section className="panel report-panel">
                    <div className="panel-header">
                        <span className="icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M4 19.25H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M7.5 16.25V11.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M12 16.25V7.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                <path d="M16.5 16.25V9.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                            </svg>
                        </span>
                        <h2>Inspeções do período selecionado</h2>
                        <span className="badge-count">{viewedRecords.length} inspeções</span>
                    </div>

                    <div className="view-filters">
                        <div className="minimal-filter-bar">
                            <div className="filter-field date-range-field" ref={datePickerRef}>
                                <label id="date-range-label">Período</label>
                                <button
                                    type="button"
                                    className={`date-range-picker-trigger ${isDatePickerOpen ? 'active' : ''}`}
                                    onClick={() => setIsDatePickerOpen((prev) => !prev)}
                                    aria-labelledby="date-range-label"
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="calendar-icon">
                                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                        <line x1="16" y1="2" x2="16" y2="6"></line>
                                        <line x1="8" y1="2" x2="8" y2="6"></line>
                                        <line x1="3" y1="10" x2="21" y2="10"></line>
                                    </svg>
                                    <span>{formattedDateRange}</span>
                                </button>

                                {isDatePickerOpen ? (
                                    <div className="date-range-popover animate-fade-in">
                                        <div className="popover-presets">
                                            <p className="presets-title">Atalhos</p>
                                            <button
                                                type="button"
                                                className={activeViewPreset === 'today' ? 'preset-btn active' : 'preset-btn'}
                                                onClick={() => applyViewPreset('today')}
                                            >
                                                Hoje
                                            </button>
                                            <button
                                                type="button"
                                                className={activeViewPreset === 'week' ? 'preset-btn active' : 'preset-btn'}
                                                onClick={() => applyViewPreset('week')}
                                            >
                                                Últimos 7 dias
                                            </button>
                                            <button
                                                type="button"
                                                className={activeViewPreset === 'month' ? 'preset-btn active' : 'preset-btn'}
                                                onClick={() => applyViewPreset('month')}
                                            >
                                                Mês atual
                                            </button>
                                        </div>
                                        <div className="popover-calendar">
                                            <div className="calendar-header">
                                                <button type="button" className="cal-nav-btn" onClick={handlePrevMonth} aria-label="Mês anterior">
                                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                                                </button>
                                                <span className="calendar-month-label">{calendarMonthLabel}</span>
                                                <button type="button" className="cal-nav-btn" onClick={handleNextMonth} aria-label="Próximo mês">
                                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                                                </button>
                                            </div>
                                            <div className="calendar-weekdays">
                                                {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((day) => (
                                                    <span key={day} className="weekday">{day}</span>
                                                ))}
                                            </div>
                                            <div className="calendar-grid">
                                                {calendarDays.map((cell) => {
                                                    const isSelectedStart = cell.dateStr === viewStartDate
                                                    const isSelectedEnd = cell.dateStr === viewEndDate
                                                    const isInRange = viewEndDate && cell.dateStr > viewStartDate && cell.dateStr < viewEndDate
                                                    const isTempSelected = cell.dateStr === tempStartDate && !viewEndDate

                                                    let cellClass = 'calendar-day'
                                                    if (!cell.isCurrentMonth) cellClass += ' outside-month'
                                                    if (isSelectedStart) cellClass += ' range-start'
                                                    if (isSelectedEnd) cellClass += ' range-end'
                                                    if (isInRange) cellClass += ' range-mid'
                                                    if (isTempSelected) cellClass += ' range-temp'

                                                    return (
                                                        <button
                                                            key={cell.dateStr}
                                                            type="button"
                                                            className={cellClass}
                                                            onClick={() => handleCalendarDayClick(cell.dateStr)}
                                                        >
                                                            {cell.dayNum}
                                                        </button>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                ) : null}
                            </div>

                            <div className="filter-field">
                                <label id="status-filter-label">Status</label>
                                <select
                                    value={viewStatus}
                                    onChange={(event) => {
                                        setViewStatus(event.target.value as ViewStatusFilter)
                                        setIsFilterActive(true)
                                        setActiveViewPreset(null)
                                    }}
                                    aria-labelledby="status-filter-label"
                                >
                                    <option value="Todos">Todos</option>
                                    <option value="Conforme">Conforme</option>
                                    <option value="Retrabalho">Retrabalho</option>
                                </select>
                            </div>

                            <div className="filter-field">
                                <label id="exec-filter-label">Execução</label>
                                <select
                                    value={viewReworkExecution}
                                    onChange={(event) => {
                                        setViewReworkExecution(event.target.value as ReworkExecutionFilter)
                                        setIsFilterActive(true)
                                        setActiveViewPreset(null)
                                    }}
                                    aria-labelledby="exec-filter-label"
                                >
                                    <option value="Todos">Todos</option>
                                    <option value="Pendentes">Pendentes</option>
                                    <option value="Executados">Executados</option>
                                </select>
                            </div>

                            <div className="filter-field search-field">
                                <label id="search-filter-label">Buscar</label>
                                <div className="search-input-wrapper">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="search-icon">
                                        <circle cx="11" cy="11" r="8"></circle>
                                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                    </svg>
                                    <input
                                        type="text"
                                        value={viewSearch}
                                        onChange={(event) => {
                                            setViewSearch(event.target.value)
                                            setIsFilterActive(true)
                                            setActiveViewPreset(null)
                                        }}
                                        placeholder="UH, observação, camareira..."
                                        aria-labelledby="search-filter-label"
                                    />
                                </div>
                            </div>

                            {isFilterActive ? (
                                <button type="button" className="clear-filters-btn" onClick={clearViewFilters}>
                                    Limpar
                                </button>
                            ) : null}
                        </div>
                    </div>

                    <div className="report-actions">
                        <button type="button" onClick={handleExportCsv} disabled={!viewedRecords.length}>
                            Exportar CSV
                        </button>
                        <button type="button" onClick={handleExportExcel} disabled={!viewedRecords.length}>
                            Exportar Excel
                        </button>
                    </div>

                    {isFilterActive ? (
                        <p className="filter-summary">
                            {viewedRecords.length} registros pelos filtros atuais para visualização/exportação. Conforme: {exportConformes} | Retrabalho: {exportRetrabalho} | Pendentes: {exportRetrabalhoPendente}
                        </p>
                    ) : null}

                    <div className="records-list" role="list" aria-label="Lista de inspeções">
                        {isRecordsLoading ? (
                            <p className="empty-state">Carregando inspeções do Firebase...</p>
                        ) : !viewedRecords.length ? (
                            <div className="empty-state">
                                <span className="empty-state-icon" aria-hidden="true">
                                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M4.75 6.25H19.25V18.25H4.75V6.25Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                        <path d="M8 10.25H16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                        <path d="M8 13.75H13.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                    </svg>
                                </span>
                                <p>Nenhuma inspeção encontrada com os filtros atuais.</p>
                            </div>
                        ) : (
                            viewedRecords.map((record) => (
                                <article
                                    key={record.firestoreId ?? record.id}
                                    className={`record-card ${isReworkPending(record) ? 'rework-pending-card' : ''} ${record.status === 'Retrabalho' && record.reworkDone ? 'rework-done-card' : ''}`}
                                    role="listitem"
                                >
                                    <div className="record-top">
                                        <strong>UH {record.uh}</strong>
                                        <div className="record-top-badges">
                                            <span className={getStatusClassName(record.status)}>{record.status}</span>
                                            {record.status === 'Retrabalho' ? (
                                                <span className={record.reworkDone ? 'rework-state-badge done' : 'rework-state-badge pending'}>
                                                    {record.reworkDone ? 'Executado' : 'Pendente'}
                                                </span>
                                            ) : null}
                                        </div>
                                    </div>
                                    {record.status === 'Retrabalho' ? (
                                        <div className={record.reworkDone ? 'rework-alert done' : 'rework-alert pending'}>
                                            <span className="rework-alert-dot" aria-hidden="true" />
                                            <div>
                                                <strong>{record.reworkDone ? 'Retrabalho concluído' : 'Retrabalho aguardando execução'}</strong>
                                                <span>
                                                    {record.reworkDone
                                                        ? `Finalizado em ${formatDateTimeBR(record.reworkCompletedAt)}${record.reworkCompletedByEmail ? ` por ${record.reworkCompletedByEmail}` : ''}`
                                                        : 'Deixe esta UH em atenção até a camareira concluir a correção.'}
                                                </span>
                                            </div>
                                        </div>
                                    ) : null}
                                    <p>
                                        <b>Camareira:</b> {record.housekeeper || 'Não informado'}
                                    </p>
                                    <p>
                                        <b>Inspetor(a):</b> {record.inspector || 'Não informado'}
                                    </p>
                                    <p>
                                        <b>Data:</b> {formatDateBR(record.date)}
                                    </p>
                                    <p>
                                        <b>Hora:</b> {record.time}
                                    </p>
                                    <p>
                                        <b>Observação:</b> {record.note || 'Sem observação'}
                                    </p>
                                    <div className="card-actions">
                                        {isReworkPending(record) ? (
                                            <button
                                                type="button"
                                                className="card-btn highlight"
                                                onClick={() => handleMarkReworkDone(record)}
                                                disabled={!record.firestoreId}
                                            >
                                                Marcar retrabalho executado
                                            </button>
                                        ) : null}
                                        <button type="button" className="card-btn" onClick={() => handleEditRecord(record)}>
                                            Editar
                                        </button>
                                        <button
                                            type="button"
                                            className="card-btn danger"
                                            onClick={() => requestDeleteRecord(record.firestoreId)}
                                            disabled={!record.firestoreId}
                                        >
                                            Excluir
                                        </button>
                                    </div>
                                </article>
                            ))
                        )}
                    </div>
                </section>
                ) : null}
            </main>

            <footer className="app-footer">
                <p>© {new Date().getFullYear()} Sarah Bomfim</p>
            </footer>

            {editModalOpen ? (
                <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Editar inspeção">
                    <div className="modal-card zoom-in">
                        <div className="modal-header">
                            <h3>Editar inspeção</h3>
                            <button type="button" className="close-modal" onClick={closeEditModal}>
                                Fechar
                            </button>
                        </div>

                        <form onSubmit={handleEditSave} className="inspection-form">
                            <div className="audit-meta">
                                <p><b>Criado em:</b> {formatDateTimeBR(editRecordAudit?.createdAt)}</p>
                                <p><b>Criado por:</b> {editRecordAudit?.createdByEmail || 'Não informado'}</p>
                                <p><b>Última atualização:</b> {formatDateTimeBR(editRecordAudit?.updatedAt)}</p>
                                <p><b>Atualizado por:</b> {editRecordAudit?.updatedByEmail || 'Não informado'}</p>
                            </div>

                            <label>
                                UH
                                <select value={editUh} onChange={(event) => setEditUh(event.target.value)} required>
                                    {rooms.map((room) => (
                                        <option key={room} value={room}>
                                            UH {room}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            <div className="two-columns">
                                <label>
                                    Camareira
                                    <input
                                        type="text"
                                        value={editHousekeeper}
                                        onChange={(event) => setEditHousekeeper(event.target.value)}
                                        placeholder="Nome da camareira"
                                        required
                                    />
                                </label>

                                <label>
                                    Inspetor(a)
                                    <input
                                        type="text"
                                        value={editInspector}
                                        onChange={(event) => setEditInspector(event.target.value)}
                                        placeholder="Quem inspecionou"
                                        required
                                    />
                                </label>
                            </div>

                            <div className="status-group" role="radiogroup" aria-label="Status da inspeção">
                                <button
                                    type="button"
                                    className={
                                        editStatus === 'Conforme' ? 'status-btn active conforme' : 'status-btn conforme'
                                    }
                                    onClick={() => setEditStatus('Conforme')}
                                >
                                    Conforme
                                </button>
                                <button
                                    type="button"
                                    className={
                                        editStatus === 'Retrabalho' ? 'status-btn active retrabalho' : 'status-btn retrabalho'
                                    }
                                    onClick={() => setEditStatus('Retrabalho')}
                                >
                                    Retrabalho
                                </button>
                            </div>

                            {editStatus === 'Retrabalho' ? (
                                <label className="checkbox-field">
                                    <input
                                        type="checkbox"
                                        checked={editReworkDone}
                                        onChange={(event) => setEditReworkDone(event.target.checked)}
                                    />
                                    <span>Retrabalho realizado</span>
                                </label>
                            ) : null}

                            <div className="three-columns">
                                <label>
                                    Data
                                    <input
                                        type="date"
                                        value={editDate}
                                        onChange={(event) => handleEditDateChange(event.target.value)}
                                        required
                                    />
                                </label>

                                <label>
                                    Hora
                                    <input
                                        type="time"
                                        value={editTime}
                                        onChange={(event) => setEditTime(event.target.value)}
                                        required
                                    />
                                </label>
                            </div>

                            <label>
                                Observação
                                <textarea
                                    value={editNote}
                                    onChange={(event) => setEditNote(event.target.value)}
                                    placeholder="Ex.: Poeira no rodapé"
                                    rows={3}
                                />
                            </label>

                            <button type="submit" className={isSavingEdit ? 'save-btn is-saving' : 'save-btn'}>
                                {isSavingEdit ? 'Atualizando...' : 'Salvar alterações'}
                            </button>
                        </form>
                    </div>
                </div>
            ) : null}

            {confirmDialog.isOpen ? (
                <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={confirmDialogTitle}>
                    <div className="confirm-card zoom-in-soft">
                        <h3>{confirmDialogTitle}</h3>
                        <p>{confirmDialogMessage}</p>
                        {confirmDialog.action === 'limpar' ? (
                            <div className="confirm-password-block">
                                <label>
                                    Confirme com sua senha
                                    <input
                                        type="password"
                                        value={clearRecordsPassword}
                                        onChange={(event) => {
                                            setClearRecordsPassword(event.target.value)
                                            if (clearRecordsError) {
                                                setClearRecordsError('')
                                            }
                                        }}
                                        placeholder="Digite a mesma senha do login"
                                        autoComplete="current-password"
                                    />
                                </label>
                                {clearRecordsError ? <p className="confirm-error">{clearRecordsError}</p> : null}
                            </div>
                        ) : null}
                        <div className="confirm-actions">
                            <button type="button" className="ghost-btn" onClick={closeConfirmDialog}>
                                Cancelar
                            </button>
                            <button type="button" className="danger-confirm" onClick={handleConfirmDialog} disabled={isConfirmingClear}>
                                {isConfirmingClear ? 'Validando...' : 'Confirmar'}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    )
}

export default App
