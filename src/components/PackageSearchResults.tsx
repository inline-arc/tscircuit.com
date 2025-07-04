import { Package } from "fake-snippets-api/lib/db/schema"
import { Search } from "lucide-react"
import React from "react"
import { PackageCard } from "./PackageCard"
import { PackageCardSkeleton } from "./PackageCardSkeleton"

interface PackageSearchResultsProps {
  isLoading: boolean
  error: unknown
  filteredPackages: Package[] | undefined
  apiBaseUrl: string
  emptyStateMessage: string
}

const PackageGrid = ({
  packages,
  baseUrl,
}: { packages: Package[]; baseUrl: string }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
    {packages.map((pkg) => (
      <PackageCard
        key={pkg.package_id}
        pkg={pkg}
        baseUrl={baseUrl}
        showOwner={true}
      />
    ))}
  </div>
)

const LoadingState = () => (
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
    {[...Array(6)].map((_, i) => (
      <PackageCardSkeleton key={i} />
    ))}
  </div>
)

const ErrorState = () => (
  <div className="bg-red-50 border border-red-200 text-red-700 p-6 rounded-xl shadow-sm max-w-2xl mx-auto">
    <div className="flex items-start">
      <div className="mr-4 bg-red-100 p-2 rounded-full">
        <Search className="w-6 h-6 text-red-600" />
      </div>
      <div>
        <h3 className="text-lg font-semibold mb-2">Error Loading packages</h3>
        <p className="text-red-600">
          We couldn't load the trending packages. Please try again later.
        </p>
      </div>
    </div>
  </div>
)

const EmptyState = ({
  message,
}: {
  message?: string
}) => (
  <div className="text-center py-12 px-4">
    <div className="bg-slate-50 inline-flex rounded-full p-4 mb-4">
      <Search className="w-8 h-8 text-slate-400" />
    </div>
    <h3 className="text-xl font-medium text-slate-900 mb-2">
      No Matching Packages
    </h3>
    {message && (
      <p className="text-slate-500 max-w-md mx-auto mb-6">{message}</p>
    )}
  </div>
)

const PackageSearchResults: React.FC<PackageSearchResultsProps> = ({
  isLoading,
  error,
  filteredPackages,
  apiBaseUrl,
  emptyStateMessage,
}) => {
  if (isLoading) return <LoadingState />
  if (error) return <ErrorState />
  if (!filteredPackages?.length)
    return <EmptyState message={emptyStateMessage} />
  return <PackageGrid packages={filteredPackages} baseUrl={apiBaseUrl} />
}

export default PackageSearchResults
